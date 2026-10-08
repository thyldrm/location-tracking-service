# ADR 0006 — Ingestion path: Kafka producer, rate limiting and behaviour under failure

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

`POST /locations` is the only high-volume endpoint (~10,000 requests/s at target load, every active user every
5 s). It must answer quickly, never lose an acknowledged ping, protect the system from misbehaving clients, and
keep a failure of Kafka or Redis from turning into a wider outage. The database is not on this path (ADR 0001).

## Decisions

### Kafka client: `@confluentinc/kafka-javascript`

Confluent's binding to librdkafka, the C library used by most non-Java Kafka clients, with a promise-based API.
KafkaJS was rejected because it is no longer actively maintained (last release in 2023). The cost is a native module: its install script must run
(explicitly allowed for one version in `allowScripts`), and the image rebuilds it in the production dependency
stage.

### Producer settings

| Setting                              | Value                             | Why                                                                                                    |
| ------------------------------------ | --------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `enable.idempotence`                 | `true` (implies `acks=all`)       | `202` means every in-sync replica has the ping; internal retries cannot duplicate or reorder messages. |
| `linger.ms`                          | 5                                 | Concurrent requests share batches; measured p50 ≈ 9 ms per request in a Linux container.               |
| `compression.codec`                  | `lz4`                             | Cheap CPU, smaller batches on the wire and on disk.                                                    |
| `message.timeout.ms`                 | `KAFKA_DELIVERY_TIMEOUT_MS` = 3 s | Clients send a new ping every 5 s; waiting longer is pointless.                                        |
| `queue.buffering.max.messages`       | 100,000                           | Bounded memory: a full queue fails fast (`503`, `Retry-After: 1`).                                     |
| `socket.connection.setup.timeout.ms` | 3 s                               | Bounds a connection attempt; shutdown waits for one in progress (measured: 11 s → 3 s).                |

Message key = `userId`, so all pings of a user land in one partition and are consumed in order.

### Kafka is not required to start

The producer connects in the background and reconnects on failure. Until it is connected, `publish` fails
immediately and the API answers `503`; every other endpoint works. Blocking startup on Kafka would make a Kafka
outage also take down area management and logs, and pods restarted during the outage would never become live.

### Topics are provisioned explicitly

Brokers do not auto-create topics. Topic settings live in code (`topic-definitions.ts`) and a one-off job creates
missing topics, like database migrations. Existing topics are never changed automatically: increasing partitions of
a keyed topic moves keys between partitions and breaks per-user ordering during the change. `location.pings.v1` is
created with 24 partitions, the upper bound on worker parallelism.

### Rate limiting: fixed window in Redis, failing open

One `MULTI` with `INCR`, `PEXPIRE … NX` and `PTTL`: atomic, one round trip, shared by all API instances. A fixed
window allows a burst of up to twice the limit across a window boundary; for a limit of 10 pings per 10 s against an
expected 2, this is acceptable and much simpler than a sliding window or token bucket.

If Redis fails or exceeds `REDIS_COMMAND_TIMEOUT_MS` (100 ms), the ping is accepted. Rate limiting protects against
misbehaving clients; it must not make Redis a single point of failure for ingestion. The failure is logged at most
once a minute.

### Logging

Access logs of `POST /locations` are written at `debug`; `429` and `503` raised on purpose are expected errors. An
outage is reported by the component that detects it (Kafka client, Redis client), not once per rejected request.

## Consequences

- While the broker is unreachable but the producer was connected before, each request waits up to the delivery
  timeout (3 s) before its `503`. At full load this holds many requests open. A circuit breaker that fails fast once
  the broker is known to be down belongs with the readiness work (milestone 8). Resolved by the circuit breaker of
  [ADR 0010](0010-operability.md).
- A fixed window can admit a short burst of up to twice the limit at window boundaries.
- The topic layout is fixed at creation; changing partition counts is an operational procedure, not a deploy step.
- Windows development machines measure much higher latencies (15.6 ms timer resolution); performance is judged in
  Linux containers.
