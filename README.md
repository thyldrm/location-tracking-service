# Location Tracking Service

A NestJS microservice that ingests user location pings (≈ every 5 s per active user), detects when a user
enters a predefined polygonal area and records the entry.

The full behaviour (API and messaging contracts, data model, entry detection algorithm, failure handling)
is specified in [SPEC.md](SPEC.md).

## Quick start

Prerequisites: Node.js 24, Docker. Every command below runs as-is in bash, zsh and PowerShell
(in `cmd.exe`, use `copy` instead of `cp`).

```bash
cp .env.example .env
npm ci
docker compose up -d          # PostgreSQL/PostGIS, Kafka, Redis
npm run migration:run         # builds, then applies pending migrations
npm run topics:provision      # builds, then creates missing Kafka topics
npm run start:dev             # API role on :3000
npm run start:worker:dev      # worker role on :3001 (second terminal)
```

Everything in containers (migrations and topic provisioning run as one-off jobs before the api and worker start):

```bash
docker compose --profile app up -d --build
curl http://localhost:3000/health/live   # Windows PowerShell 5.1: curl.exe
```

## Scripts

| Command                                              | Purpose                                                    |
| ---------------------------------------------------- | ---------------------------------------------------------- |
| `npm run build`                                      | Compile to `dist/`                                         |
| `npm run lint` / `npm run typecheck`                 | Static checks                                              |
| `npm test`                                           | Unit tests (no infrastructure needed)                      |
| `npm run test:integration`                           | Integration and e2e tests against real containers (Docker) |
| `npm run migration:run` / `npm run migration:revert` | Apply pending migrations / revert the latest one           |
| `npm run topics:provision`                           | Create missing Kafka topics                                |
| `npm run format`                                     | Format with Prettier                                       |

## Technical choices

| Concern             | Choice                                                       | Why                                                                                                                                                                                                                                      |
| ------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service shape       | One repository and image, two process roles (API and worker) | One bounded context and schema, but ingestion and processing scale differently. The database stays off the ingestion path. ([ADR 0001](docs/adr/0001-single-service-with-two-process-roles.md))                                          |
| Framework / runtime | NestJS 12 (ESM) on Node.js 24 LTS, Fastify adapter           | Required framework; Fastify has lower per-request overhead on a high-RPS ingestion endpoint. ([ADR 0002](docs/adr/0002-runtime-and-tooling-baseline.md))                                                                                 |
| Database            | PostgreSQL 18 + PostGIS 3.6                                  | Native polygon type, validity checks (`ST_IsValid`) and GiST spatial indexes.                                                                                                                                                            |
| Polygon model       | GeoJSON `Polygon` in, `geometry(Polygon, 4326)` stored       | GeoJSON is the de-facto exchange format; SRID 4326 matches GPS coordinates; planar checks are accurate at city scale.                                                                                                                    |
| ORM                 | TypeORM                                                      | Maps PostGIS geometry columns natively (Prisma needs raw SQL for them) and gives explicit transaction control.                                                                                                                           |
| Kafka producer      | Idempotent, `acks=all`, 5 ms linger, bounded queue           | `202` means the ping is on every in-sync replica. A full queue or a broker timeout answers `503` instead of growing memory. The API starts and serves other endpoints while Kafka is down. ([ADR 0006](docs/adr/0006-ingestion-path.md)) |
| Message broker      | Apache Kafka                                                 | Pings keyed by `userId` stay ordered per user, consumers scale through consumer groups, and retained messages can be replayed. RabbitMQ and BullMQ cannot keep per-user ordering with competing consumers as easily.                     |
| Rate limiting       | Fixed-window counter per user in Redis, fails open           | One atomic round trip, shared by all API instances. A Redis outage must not stop ingestion, so requests are allowed while Redis is unavailable. ([ADR 0006](docs/adr/0006-ingestion-path.md))                                            |
| Cache               | Redis                                                        | Hot per-user presence state and per-user rate limits. It is never the source of truth: losing Redis slows the service down but loses no data.                                                                                            |
| Hot-path geometry   | In-memory R-tree (`flatbush`) + exact point-in-polygon       | Areas are few and change rarely, pings are many: point-in-polygon runs without a database round trip. PostgreSQL remains the source of truth.                                                                                            |
| Reliable events     | Transactional outbox                                         | Entries and their `area.entered` events are committed atomically, avoiding the database-plus-broker dual-write problem.                                                                                                                  |
| Idempotency         | Natural keys (`user_area_presence` primary key)              | Kafka delivers at least once; duplicates are absorbed without a per-message inbox write.                                                                                                                                                 |
| Safe client retries | `Idempotency-Key` on `POST /areas`                           | A client that lost the response can retry and gets the original area back instead of a `409` or a duplicate. The key is claimed in the same transaction as the area. ([ADR 0005](docs/adr/0005-areas-api.md))                            |
| Request validation  | Zod schemas in a NestJS pipe                                 | One library for configuration and payloads; handlers only ever receive parsed, typed input, and every failure lists the offending fields.                                                                                                |
| Pagination          | Keyset (cursor) on `(created_at, id)`                        | Constant cost per page served straight from an index, and no skipped or repeated rows when data changes between pages, unlike `OFFSET`.                                                                                                  |
| Logging             | Structured JSON to stdout (pino)                             | 12-factor: the platform collects and ships logs; the service writes no log files. ([ADR 0004](docs/adr/0004-errors-correlation-and-logging.md))                                                                                          |
| Errors              | RFC 9457 Problem Details from one global filter              | Standard, machine-readable error types; internal details are logged, never returned.                                                                                                                                                     |
| Request correlation | `x-request-id` + AsyncLocalStorage                           | One id follows a request through logs, Kafka headers and outbox events, without request-scoped providers.                                                                                                                                |

## Assumptions

- **Load:** ~50,000 concurrently active users → ~10,000 pings/s, with headroom to ~20,000 pings/s by scaling out.
  Areas number in the thousands at most and change rarely.
- **Authentication:** end-user authentication happens at an upstream API gateway. This service trusts the `userId`
  in the request and protects its endpoints with a service API key (`x-api-key`).
- **Raw pings are not stored in PostgreSQL** (~860M rows/day at target load). They are retained in Kafka for 7 days;
  only areas, entries and presence state are persisted.
- **"Entry"** means an outside → inside transition. Staying inside does not create new logs. A point on the
  boundary counts as inside, and overlapping areas each produce their own entry.
- **Entry time** is the client timestamp of the first ping inside the area. Timestamps more than 60 s in the future
  or older than 24 h are rejected.
- **Out-of-order pings** (older than the user's last processed ping) do not change state.
- **Stale sessions:** if a user sends no ping for 15 minutes, their previous presence is closed, so the next session
  inside the same area counts as a new entry.
- **Eventual consistency:** `POST /locations` returns `202 Accepted` once the ping is durably in Kafka. The entry
  appears in `GET /logs` shortly after (target < 1 s).
- **Coordinates** are WGS84; GeoJSON positions are `[longitude, latitude]`.
- **Areas** have unique names (case-insensitive) and must be valid polygons according to PostGIS. They are never
  updated or deleted in v1, and none crosses the antimeridian (the service operates in Turkey).

## Out of scope

These matter in production, but this implementation leaves them out on purpose:

- End-user authentication and authorization (delegated to the gateway).
- GPS noise filtering at area boundaries (hysteresis, minimum dwell time, accuracy thresholds).
- Updating or deleting areas, and the semantics of open presences on a changed area.
- Long-term raw location history and analytics (Kafka → object storage / time-series store).
- Batched ping ingestion for clients that were offline.
- Partitioning `area_entries` by time once volume requires it.
- Multi-region deployment and disaster recovery.
- Background sweeper for users who stopped sending pings while inside an area (handled lazily on the next ping).

## Documentation

- [SPEC.md](SPEC.md) — behaviour, API and messaging contracts, data model, failure modes
- [docs/adr/](docs/adr/) — architecture decision records

## Status

Under active development. Milestones are tracked in [SPEC.md §13](SPEC.md#13-milestones).
