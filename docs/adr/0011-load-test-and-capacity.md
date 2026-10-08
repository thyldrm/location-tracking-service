# ADR 0011 — Load test and capacity of the ingestion path

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

SPEC §11 sets two targets at ~10,000 pings/s: `POST /locations` p99 below 50 ms, and a ping's entry visible within
1 s (p99). Neither had been measured. Capacity per instance was also unknown, and the number of instances needed
for the target load depends on it.

## Decisions

### A k6 load test against the compose stack, open model

`load/ingest.js` ([load/README.md](../../load/README.md)) runs k6 in a container on the compose network:

- **Open model** (`constant-arrival-rate`): requests start at the given rate whether earlier ones finished or not,
  like independent clients. A closed model (a fixed number of virtual users in a loop) sends less when the server
  slows down, so its latency hides the queueing that real clients would see (coordinated omission).
- **Pass or fail in the script:** p99 seen by the client, plus the share of requests within 50 ms and of pings
  processed within 1 s, read from the services' histograms at a bucket boundary (exact, not interpolated).
  Iterations that k6 cannot start because the system is behind count as failures above 0.1 %.
- **Realistic work for the worker:** 50,000 simulated users move along a route; one in ten crosses four areas, so
  the worker writes entries and exits, not only unchanged pings.
- `load/compose.scale.yml` removes the fixed host ports, so the api and the worker can be scaled with
  `--scale`; `api` then resolves to every api container on the compose network.

### Remove per-request work found by profiling

The first runs saturated one API instance at about 900 pings/s. Even `GET /health/live`, which touches no dependency,
stopped at about 2,700 requests/s, while a bare Fastify server in the same environment served 12,000. Per-thread CPU
showed the Node.js main thread at 94 % and the Kafka client's threads below 20 %: the limit is JavaScript work per
request. A CPU profile put about three quarters of it in request plumbing (routing, guard, pipes, request context,
HTTP logging, writing the response) and one quarter in the ingestion logic.

Two changes, each measured in isolation:

| Change                                                                                          | Effect                                                         |
| ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| nestjs-cls stopped resolving proxy providers on every request (a dynamic `import()`; none used) | liveness of one instance: ~2,700 → ~3,900 requests/s           |
| Rate limit as one Lua script instead of `MULTI` with four commands                              | client CPU per call: ~42 → ~13 µs; same atomicity, one command |

### Capacity is planned per instance; the target is reached by scaling out

Measured on one 16-core laptop running k6, Kafka, PostgreSQL, Redis and the services side by side (Docker Desktop):

| Containers       | Rate (pings/s) | Duration | Client p99 | Server ≤ 50 ms | Processed ≤ 1 s | Result                                                                |
| ---------------- | -------------- | -------- | ---------- | -------------- | --------------- | --------------------------------------------------------------------- |
| 1 api, 1 worker  | 1,000          | 60 s     | 25 ms      | 99.998 %       | 100 %           | pass                                                                  |
| 1 api, 1 worker  | 1,100          | 90 s     | 15 ms      | 100 %          | 100 %           | pass                                                                  |
| 1 api, 1 worker  | 1,250          | 2 min    | 90 ms      | 99.0 %         | 100 %           | fail: the main thread saturates                                       |
| 2 api, 2 workers | 2,500          | 45 s     | 39 ms      | 99.997 %       | 100 %           | pass                                                                  |
| 4 api, 3 workers | 3,500          | 45 s     | 126 ms     | 91 %           | 100 %           | fail: the host is out of CPU (13 of 16 cores; k6 and Kafka ~2.8 each) |

- One API instance sustains about 1,100 pings/s within the targets; two instances twice that. Beyond about
  3,000 pings/s this machine measures itself, not the service.
- Runs at the same rate differ by up to ~15 % depending on what else the host does.
- One worker processed a backlog of 120,000 pings at about 10,000 pings/s (large batches). The worker is not the
  bottleneck; under live load its batches are small and its CPU per ping is higher.
- Freshness held in every run that kept up: every ping was processed within 1 s of being accepted.

Planning figure: **1,000 pings/s per API instance with one CPU core.** The target of 10,000 pings/s needs 10
instances, 13 with 30 % headroom; 20,000 pings/s needs about 26. The API scales on CPU, the worker on consumer lag
(milestone 10); the worker needs at least 3 instances for availability, and at most 24 (the partition count) are
useful.

## Alternatives considered

- **Replace the remaining request plumbing with Fastify hooks** (request context, HTTP logging without a child
  logger per request, no NestJS middleware layer). It would raise the capacity per instance further, at the cost of
  code that departs from NestJS conventions. Not done: scaling out is cheaper than that complexity at this load.
- **Several Node.js processes per container** (cluster module). Kubernetes already runs one process per core as
  separate pods, with independent health checks and scheduling.
- **A larger producer linger** to batch more pings per Kafka request: Kafka's CPU was not the limit of one API
  instance, and every millisecond of linger is added to each request's latency.

## Consequences

- The latency target is met per instance up to ~1,100 pings/s; the target load needs horizontal scaling, which the
  design already relies on (stateless API, partitioned topic).
- The numbers come from a laptop with every component co-located and no network between them. They are a planning
  baseline to verify on the production hardware with the same script, not a guarantee.
- The load test is a manual tool, not part of CI: its results depend on the machine it runs on.
