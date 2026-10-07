# ADR 0001 — One service, one repository, two process roles

- **Status:** Accepted
- **Date:** 2026-10-07

## Context

The case asks for _a_ microservice that ingests location pings every ~5 s per active user, detects area
entries and exposes areas and entry logs over HTTP. Traffic is expected to grow significantly.

The workload has two parts with very different scaling profiles:

1. **Ingestion** — many small HTTP requests; must answer quickly; stateless.
2. **Processing** — point-in-polygon checks, state transitions and transactional writes; ordered per user.

Options considered:

| Option                                             | Pros                                                                                | Cons                                                                                                                                         |
| -------------------------------------------------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| A. Single process doing everything synchronously   | Simplest                                                                            | Database on the hot path of every request; ingestion latency and availability tied to the database; cannot scale the two parts independently |
| B. Several microservices (ingest, geofence, query) | Independent deployability                                                           | One bounded context and one schema split across services; network hops and distributed consistency problems with no organisational benefit   |
| C. One codebase and image, two process roles       | Independent scaling; shared domain model and schema; one deployment unit to version | Two Deployments to operate                                                                                                                   |

## Decision

Option C. One repository and one container image with two entrypoints:

- `dist/main.js` — **API role**: HTTP endpoints; produces pings to Kafka.
- `dist/worker.js` — **Worker role**: consumes pings, detects entries, runs the outbox relay; exposes only
  health and metrics over HTTP.

Both roles share `CoreModule` (configuration, logging, database, messaging) and the feature modules.

## Consequences

- The API scales on request rate; the worker scales on consumer lag, up to the partition count of the ping topic.
- A database outage does not stop ingestion: pings accumulate in Kafka and are processed on recovery.
- Entry logs are eventually consistent with accepted pings (see SPEC §3.10).
- Splitting the roles into separate services later is cheap because the boundary already exists.
