# ADR 0010 — Operability: metrics, readiness, circuit breaker and graceful shutdown

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

The service has to be run by people who did not write it: they need to see whether it meets its targets, the
orchestrator needs to know when to send it traffic, a broker outage must not pile up thousands of waiting requests,
and deployments must not drop requests. ADR 0006 left one gap open: while Kafka timed out, every `POST /locations`
waited the full delivery timeout.

## Decisions

### Metrics: Prometheus, defined in one place

`GET /metrics` exposes Prometheus metrics, all defined in `Metrics` (`src/core/metrics/metrics.ts`):

- **HTTP:** `http_request_duration_seconds` by route template and status, timed by a Fastify hook so that requests
  rejected before a controller are counted too.
- **Ingestion:** accepted pings, rejected pings by reason, requests let through while Redis is down.
- **Entry detection:** processed pings by outcome, the delay from acceptance in the API to the end of processing
  (the freshness target), dead letters by reason, entries and exits written, the area index's size and last load.
- **Outbox:** published and failed events, and from the table at scrape time the backlog, the age of the oldest
  unpublished event and the parked events. The age is the alerting signal: it rises whenever events are late,
  whatever the traffic. These gauges are NaN while the database is unreachable, rather than a stale or zero value
  that would look healthy.
- **Process:** prom-client's default metrics, among them the event loop lag.

Labels only take values from small fixed sets. A raw path or a user id as a label creates a time series per value
and eventually exhausts the monitoring system. Each application owns its registry; the process role is a label on
every series.

Consumer lag is not exported by the service. It is a property of the consumer group, read from the brokers by an
exporter or by the autoscaler (KEDA), which keeps working when every worker is down.

### Readiness reflects the process, not shared dependencies

`GET /health/ready` answers 503 only while the process is starting (a startup gate is not met: the worker's area
index is not loaded) or shutting down. The database, Kafka and Redis are reported in the body but do not decide
readiness.

The first plan (SPEC §10) failed readiness when Kafka was down. An outage of a shared dependency hits every instance
at once. Failing readiness everywhere removes all instances from the load balancer: `GET /areas` and `GET /logs`,
which do not need Kafka, would fail too, and clients would get the load balancer's error instead of the service's
`503` with `Retry-After`. Readiness answers "should this instance get traffic rather than another one?", and for a
shared outage the answer is no different for any instance. Liveness checks nothing but the event loop, so an outage
never restarts healthy processes.

### Circuit breaker on publishing pings

After `KAFKA_BREAKER_FAILURE_THRESHOLD` (5) consecutive `timeout` or `unavailable` errors, the breaker opens and
`POST /locations` answers `503` at once, with `Retry-After` set to the remaining open time. After
`KAFKA_BREAKER_OPEN_MS` (5 s) exactly one trial request goes through; its result closes or reopens the circuit.
Results of requests admitted before the circuit opened do not change its state. A full producer queue
(backpressure) and rejected messages do not count: they say nothing about the broker being down.

Measured in docker compose with 8 concurrent clients and Kafka stopped: requests waited 3 s until the fifth timeout,
then about 130 requests per second were answered `503` within 20 ms. Every 5 s one trial waited 3 s. Once Kafka was
back, the next successful trial closed the circuit and pings were accepted again.

### Graceful shutdown with a drain period

On `SIGTERM` the API fails readiness and keeps serving for `SHUTDOWN_DRAIN_DELAY_MS` (5 s), because an orchestrator
removes a terminating pod from the load balancer asynchronously. Then `app.close()` stops accepting connections, waits
for requests in progress and runs the shutdown hooks. The consumers commit their offsets, the relay finishes its pass,
then the producer flushes and the pools close. The worker serves no routed traffic and closes at once. If the
shutdown fails or exceeds `SHUTDOWN_TIMEOUT_MS` (25 s, below Kubernetes' default grace period of 30 s), the process
exits with code 1 instead of being killed. `SIGINT` (Ctrl+C) closes without draining.

Measured in docker compose:

| Role   | Under load    | Result                                                                                                                                                                                         |
| ------ | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API    | ~125 pings/s  | Readiness turned 503 at SIGTERM. Pings were still accepted for 5 s with no error, then the server closed. The process exited with code 0 16 ms later.                                          |
| Worker | Pings flowing | Consumers revoked their partitions and disconnected, then the producer disconnected. The process exited with code 0 in 16 ms. After the restart, consumer lag returned to 0: no ping was lost. |

## Consequences

- A Kafka outage costs at most `KAFKA_BREAKER_FAILURE_THRESHOLD` requests waiting the delivery timeout per open
  period, instead of every request.
- Recovery after Kafka returns can take up to one open period, until the next trial.
- A shared outage is visible in `/health/ready` and in metrics, and is answered by the service's own `503`s. Alerting
  on it is the job of the monitoring system, not of the orchestrator.
- A rolling deployment takes at least the drain delay per API instance.
