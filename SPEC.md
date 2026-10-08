# Location Tracking Service — Specification

This document is the single source of truth for the behaviour of the service.
Code, tests and the README must agree with it. When behaviour changes, this file changes first.

- **Status:** Draft v1 (implementation in progress, see [§13 Milestones](#13-milestones))
- **Owner:** Location Tracking Service team

---

## 1. Purpose

Mobile clients send the current location of an active user roughly every 5 seconds.
The service detects when a user **enters** one of the predefined polygonal areas and records that entry.
Entries are queryable over HTTP and are also published as domain events so that other services
(notifications, pricing, fleet operations) can react to them.

Traffic is expected to grow significantly over time, so the design must scale horizontally
and keep the primary database off the hot path.

## 2. Glossary

| Term            | Meaning                                                                                                     |
| --------------- | ----------------------------------------------------------------------------------------------------------- |
| **Ping**        | One location sample sent by a client: user id, latitude, longitude, client timestamp.                       |
| **Area**        | A named polygon (GeoJSON `Polygon`, WGS84) defined by an operator.                                          |
| **Presence**    | The fact that a user is currently inside an area. One row per (user, area) while inside.                    |
| **Entry**       | The transition of a user from _outside_ an area to _inside_ it. Persisted as an `area_entries` row ("log"). |
| **Exit**        | The transition from _inside_ to _outside_. Closes the open entry (`exited_at`).                             |
| **API role**    | Process that serves HTTP and produces pings to Kafka. Stateless.                                            |
| **Worker role** | Process that consumes pings, detects entries/exits and runs the outbox relay.                               |

## 3. Assumptions

These are deliberate assumptions made where the case is silent. Each is listed in the README as well.

1. **Load.** Design target is ~50,000 concurrently active users → ~10,000 pings/s (one ping per 5 s),
   with headroom to ~20,000 pings/s through horizontal scaling. Areas are few (thousands at most) and change rarely.
2. **Authentication.** End-user authentication (JWT) is performed by an upstream API gateway.
   This service trusts the `userId` in the request body and protects its endpoints with a service API key
   (`x-api-key`). In a real deployment the user id would be taken from the verified token, not from the body.
3. **Raw ping history is not stored in PostgreSQL.** At the target load that would be ~860M rows/day.
   Pings are retained in Kafka (default 7 days) for replay and debugging. Long-term history belongs in an
   analytical store and is out of scope.
4. **Timestamps.** The client timestamp (ISO 8601 with offset) is the event time. It is accepted if it is
   not more than `PING_MAX_FUTURE_SKEW_MS` (default 60 s) in the future and not older than `PING_MAX_AGE_MS`
   (default 24 h). The server also records its own receive time.
5. **Entry time** is the client timestamp of the first ping observed inside the area.
6. **Boundary semantics.** A point exactly on the polygon boundary counts as _inside_
   (PostGIS `ST_Covers` semantics). Areas may overlap; a point inside N areas produces N entries.
7. **Ordering.** Pings of the same user are processed in the order they were accepted (Kafka key = `userId`).
   A ping whose timestamp is not newer than the user's last processed ping is ignored for state transitions.
8. **Stale presence.** If the gap between two consecutive pings of a user exceeds `PRESENCE_TTL_MS`
   (default 15 min), the user's previous presence is considered stale and is closed (exit time = last known ping time)
   before the new ping is evaluated, so that a new session inside the same area produces a new entry.
9. **Coordinates** are WGS84 (SRID 4326). GeoJSON position order is `[longitude, latitude]` (RFC 7946).
10. **Eventual consistency.** `POST /locations` returns once the ping is durably stored in Kafka.
    The resulting entry becomes visible in `GET /logs` shortly after (target p99 < 1 s under normal load).
11. **GPS noise** (jitter around boundaries) is not filtered in v1. See Out of scope.

## 4. Architecture

```
 Client ──HTTP──▶ API role ──produce(key=userId)──▶ Kafka  location.pings.v1
                    │                                   │
                    │ areas, logs (read/write)          ▼
                    ▼                              Worker role (consumer group "entry-detector")
               PostgreSQL + PostGIS ◀── single tx ── 1. point-in-polygon on in-memory R-tree
               (source of truth)                     2. load previous presence (Redis cache → PostgreSQL)
                    │                                3. diff → entries / exits
                    │                                4. write presence + entries + outbox in ONE transaction
                    ▼
               outbox_events ──▶ Outbox relay (single active leader) ──▶ Kafka  area.lifecycle.v1
                                                                          Kafka  area.entries.v1
               Worker instances consume area.lifecycle.v1 (broadcast) to refresh the in-memory area index.
```

### 4.1 Deployment roles

One repository, one container image, two entrypoints:

| Role   | Entrypoint       | Responsibilities                                                                        | Scaling                                                                 |
| ------ | ---------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| API    | `dist/main.js`   | HTTP endpoints, validation, rate limiting, Kafka producer                               | Stateless, scale on CPU / RPS                                           |
| Worker | `dist/worker.js` | Ping consumer, entry detection, outbox relay, area index refresh, health & metrics HTTP | Up to the partition count of `location.pings.v1`; scale on consumer lag |

### 4.2 Technology choices (summary — rationale in `docs/adr/`)

| Concern                  | Choice                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| Runtime / framework      | Node.js 24 LTS, NestJS 12 (ESM), TypeScript 6, Fastify adapter   |
| Database                 | PostgreSQL 18 + PostGIS 3.6                                      |
| ORM                      | TypeORM (native PostGIS geometry mapping; explicit transactions) |
| Message broker           | Apache Kafka 4 (KRaft) via `@confluentinc/kafka-javascript`      |
| Cache / rate limit       | Redis 8 via `ioredis`                                            |
| Spatial index (hot path) | `flatbush` R-tree + exact point-in-polygon in memory             |
| Validation               | Zod (Standard Schema) for config and request payloads            |
| Logging                  | `pino` structured JSON to stdout                                 |
| Metrics                  | Prometheus (`prom-client`)                                       |
| Tests                    | Vitest, Testcontainers                                           |

## 5. HTTP API

### 5.0 Conventions for every endpoint

**Authentication.** Every route requires the header `x-api-key` with one of the keys configured in `API_KEYS`
(comma-separated, at least 32 characters each; several keys may be active at once to allow rotation). Routes that
must stay reachable without a key (health probes, metrics, API docs) are explicitly marked public. A missing or
invalid key returns `401` with a `WWW-Authenticate` header. Keys are compared in constant time and are never logged.
Requests to routes that do not exist return `404` before authentication runs.

**Correlation.** Every request is assigned a correlation id:

- If the request carries an `x-request-id` header matching `^[A-Za-z0-9._:-]{1,128}$` (for example one set by the
  API gateway), that value is used; otherwise a UUIDv7 is generated. Unsafe values are replaced, never echoed.
- The id is returned in the `x-request-id` response header and in the `correlationId` member of error responses.
- Every log line written while handling the request carries it as `correlationId`.
- It is propagated to Kafka message headers and outbox events, so one id follows a ping from the HTTP request
  through the worker to the domain events.

**Errors.** Every error response is an **RFC 9457 Problem Details** document (`application/problem+json`):

```json
{
  "type": "https://location-tracking-service/problems/validation-error",
  "title": "Validation failed",
  "status": 400,
  "detail": "Request body is invalid.",
  "instance": "/locations",
  "correlationId": "0192f5c4-...",
  "errors": [{ "path": "latitude", "message": "Number must be less than or equal to 90" }]
}
```

| `type` (suffix after `https://location-tracking-service/problems/`) | Status | Meaning                                                                                                                                                |
| ------------------------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `validation-error`                                                  | 400    | Request failed validation; `errors` lists the offending fields                                                                                         |
| `unauthorized`                                                      | 401    | Missing or invalid API key                                                                                                                             |
| `not-found`                                                         | 404    | The addressed resource does not exist                                                                                                                  |
| `conflict`                                                          | 409    | The request conflicts with existing state (e.g. duplicate area name)                                                                                   |
| `unprocessable`                                                     | 422    | Semantically invalid request (e.g. `Idempotency-Key` reused with a different body)                                                                     |
| `rate-limited`                                                      | 429    | Per-user rate limit exceeded; `Retry-After` set                                                                                                        |
| `service-unavailable`                                               | 503    | A dependency is unavailable or overloaded; `Retry-After` set; safe to retry                                                                            |
| `internal-error`                                                    | 500    | Unexpected failure; details are logged, never returned                                                                                                 |
| `about:blank`                                                       | 4xx    | Generic HTTP errors raised by the framework (unknown route, malformed JSON, body too large, unsupported media type); `title` is the HTTP status phrase |

Internal error messages, stack traces and infrastructure details are never included in responses. Unexpected errors
(5xx) are logged at `error` level with their stack trace and correlation id.

### 5.1 `POST /locations`

Accepts one location ping.

Request body:

| Field       | Type   | Rules                                                                     |
| ----------- | ------ | ------------------------------------------------------------------------- |
| `userId`    | string | required, 1–64 chars, `^[A-Za-z0-9_-]+$`                                  |
| `latitude`  | number | required, finite, −90…90                                                  |
| `longitude` | number | required, finite, −180…180                                                |
| `timestamp` | string | required, ISO 8601 with offset; within skew / age limits (§3.4)           |
| `accuracy`  | number | optional, meters, ≥ 0 (stored on the event, not used for decisions in v1) |

Responses:

| Status         | When                                                                                                                             |
| -------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `202 Accepted` | Ping durably written to Kafka. Body: `{ "pingId": "<uuidv7>", "status": "accepted" }`                                            |
| `400`          | Validation failed                                                                                                                |
| `401`          | Missing / invalid API key                                                                                                        |
| `429`          | Per-user rate limit exceeded (`RATE_LIMIT_PINGS_PER_WINDOW` per `RATE_LIMIT_WINDOW_MS`, default 10 per 10 s). `Retry-After` set. |
| `503`          | Kafka unavailable or producer queue full. `Retry-After` set. The client should retry or drop the ping.                           |

### 5.2 `POST /areas`

Creates an area.

```json
{
  "name": "Kadikoy No-Parking Zone",
  "description": "Optional free text",
  "geometry": {
    "type": "Polygon",
    "coordinates": [
      [
        [29.02, 40.99],
        [29.04, 40.99],
        [29.04, 41.0],
        [29.02, 41.0],
        [29.02, 40.99]
      ]
    ]
  }
}
```

Validation:

- `name`: required, 1–120 chars, trimmed. Unique among areas (case-insensitive) → `409` on conflict.
  Uniqueness is enforced by the unique index `uq_areas_name_lower`, not by a prior lookup.
- `description`: optional, ≤ 1000 chars; omitted or `null` is stored as `null`.
- `geometry`: GeoJSON `Polygon` only (holes allowed). Every ring closed (first = last position) with ≥ 4 positions.
  Positions are `[lon, lat]` within valid ranges; positions with altitude are rejected.
  Total positions of all rings ≤ `AREA_MAX_VERTICES` (default 5,000).
  Must be valid according to PostGIS `ST_IsValid`; otherwise `400` with the `ST_IsValidReason` text
  (e.g. `Self-intersection[29.03 40.995]`) as the message of the `geometry` field error.
  Ring orientation is normalised on write to RFC 7946 §3.1.6 (exterior counterclockwise, holes clockwise).

Optional header `Idempotency-Key` (1–128 visible ASCII characters):

- The first request with a key creates the area. The key, the area and its event commit in one transaction, so a key
  is only remembered when the request succeeded.
- A retry with the same key and the same (validated) body returns `201` with the original area and `Location`
  header plus `Idempotent-Replayed: true`, and creates nothing.
- Concurrent requests with the same key create exactly one area; the others wait for it and are replayed.
- The same key with a different body → `422 unprocessable`.
- Keys are scoped per operation (`areas.create`) and are retained for 24 h (deleted by the worker's housekeeping,
  milestone 6). Keys are not scoped per API client: callers are trusted internal services.

Responses: `201 Created` with the area resource and a `Location: /areas/{id}` header; `400`, `401`, `409`, `422`.

Side effect: an `area.created` event (topic `area.lifecycle.v1`, key `areaId`) is written to the outbox in the same
transaction. Its payload carries the whole area, geometry included, so workers can update their area index from the
event alone:

```json
{
  "areaId": "…",
  "name": "…",
  "description": null,
  "geometry": { "type": "Polygon", "coordinates": [] },
  "createdAt": "…"
}
```

### 5.3 `GET /areas`

Lists areas, newest first, keyset-paginated.

Query: `limit` (1–200, default 50), `cursor` (opaque, from the previous page).

Response:

```json
{
  "data": [
    {
      "id": "…",
      "name": "…",
      "description": null,
      "geometry": { "type": "Polygon", "coordinates": [] },
      "createdAt": "…"
    }
  ],
  "page": { "nextCursor": "eyJ…", "limit": 50 }
}
```

`nextCursor` is `null` on the last page. A cursor that was not produced by the service, or a `limit` out of range,
→ `400` with the field error on `cursor` / `limit`. Area timestamps have millisecond precision, the precision of the
cursor.

`GET /areas/:id` returns a single area, `404` if it does not exist, `400` if `id` is not a UUID.

### 5.4 `GET /logs`

Lists area entries, newest `enteredAt` first, keyset-paginated.

Query: `userId`, `areaId`, `from`, `to` (ISO 8601, filter on `enteredAt`, `from` inclusive, `to` exclusive),
`limit` (1–500, default 50), `cursor`.

Item:

```json
{ "id": "…", "userId": "u-42", "areaId": "…", "enteredAt": "…", "exitedAt": null, "createdAt": "…" }
```

### 5.5 Operational endpoints

| Endpoint            | Purpose                                                                         |
| ------------------- | ------------------------------------------------------------------------------- |
| `GET /health/live`  | Process is up (no dependency checks). Liveness probe.                           |
| `GET /health/ready` | Dependencies required by the role are reachable. Readiness probe.               |
| `GET /metrics`      | Prometheus metrics.                                                             |
| `GET /docs`         | OpenAPI UI (disabled when `NODE_ENV=production` unless `OPENAPI_ENABLED=true`). |

## 6. Messaging contracts

All messages are JSON, UTF-8. Headers: `x-request-id` (correlation id), `content-type: application/json`,
`schema-version`.

| Topic                   | Key      | Producer     | Consumers                                                     | Notes                                                     |
| ----------------------- | -------- | ------------ | ------------------------------------------------------------- | --------------------------------------------------------- |
| `location.pings.v1`     | `userId` | API          | Worker group `entry-detector` (work queue semantics)          | Retention 7 d. Partition count bounds worker parallelism. |
| `location.pings.v1.dlq` | `userId` | Worker       | Operators                                                     | Poison pings after retries are exhausted.                 |
| `area.lifecycle.v1`     | `areaId` | Outbox relay | Every worker instance (unique group per instance → broadcast) | `area.created`                                            |
| `area.entries.v1`       | `userId` | Outbox relay | Downstream services                                           | `area.entered`, `area.exited`                             |

Ping message value:

```json
{
  "pingId": "uuidv7",
  "userId": "u-42",
  "latitude": 40.99,
  "longitude": 29.03,
  "accuracy": 5,
  "timestamp": "2026-10-07T12:00:00.000Z",
  "receivedAt": "2026-10-07T12:00:00.120Z"
}
```

Domain event envelope (outbox):

```json
{
  "eventId": "uuidv7",
  "eventType": "area.entered",
  "schemaVersion": 1,
  "occurredAt": "…",
  "aggregateType": "user",
  "aggregateId": "u-42",
  "correlationId": "…",
  "payload": { "entryId": "…", "userId": "u-42", "areaId": "…", "enteredAt": "…" }
}
```

Delivery is **at-least-once** everywhere. Consumers must deduplicate by `eventId` (domain events)
or rely on the idempotent processing rules in §8.

## 7. Data model (PostgreSQL)

- The schema is defined by hand-written migrations in `src/core/database/migrations/` and applied by a separate
  migration step (`node dist/migrate.js`), never by the application itself (`synchronize` and `migrationsRun` are off).
  Concurrent migration runners are serialised with a PostgreSQL advisory lock. Applied migrations are recorded in
  `schema_migrations`.
- An integration test fails if the TypeORM entities and the migrated schema disagree (schema drift).
- Identifiers are UUIDv7 generated by the application (time-ordered, index-friendly, known before insert).
- Every constraint and index has an explicit name (`pk_`, `fk_`, `uq_`, `chk_`, `idx_` prefixes), so database errors
  can be mapped to API errors by constraint name.
- Connections set `statement_timeout` and `idle_in_transaction_session_timeout` and identify themselves with
  `application_name`.

### `areas`

| Column                     | Type                      | Notes                                                                  |
| -------------------------- | ------------------------- | ---------------------------------------------------------------------- |
| `id`                       | `uuid`                    | `pk_areas`                                                             |
| `name`                     | `varchar(120)`            | `uq_areas_name_lower` on `lower(name)`; `chk_areas_name_not_blank`     |
| `description`              | `text` null               |                                                                        |
| `geometry`                 | `geometry(Polygon, 4326)` | `idx_areas_geometry` (GiST); `chk_areas_geometry_valid` (`ST_IsValid`) |
| `created_at`, `updated_at` | `timestamptz`             | default `now()`                                                        |

Indexes: `idx_areas_created_at_id (created_at DESC, id DESC)` for keyset pagination.
The `geometry(Polygon, 4326)` type modifier rejects other geometry types and other SRIDs at the database level.

### `area_entries` (the "logs")

| Column       | Type               | Notes                                                                  |
| ------------ | ------------------ | ---------------------------------------------------------------------- |
| `id`         | `uuid`             | `pk_area_entries`                                                      |
| `user_id`    | `varchar(64)`      |                                                                        |
| `area_id`    | `uuid`             | `fk_area_entries_area` → `areas.id` (`ON DELETE RESTRICT`)             |
| `entered_at` | `timestamptz`      | client time of first inside ping                                       |
| `exited_at`  | `timestamptz` null | client time of first outside ping; `chk_area_entries_exit_after_entry` |
| `created_at` | `timestamptz`      | server time, default `now()`                                           |

Indexes (one per `GET /logs` access path, each ending in the keyset order):
`idx_area_entries_user_entered (user_id, entered_at DESC, id DESC)`,
`idx_area_entries_area_entered (area_id, entered_at DESC, id DESC)`,
`idx_area_entries_entered (entered_at DESC, id DESC)`.
Future: range-partition by `entered_at` (monthly) once volume requires it.

### `user_area_presence`

| Column       | Type          | Notes                                                                            |
| ------------ | ------------- | -------------------------------------------------------------------------------- |
| `user_id`    | `varchar(64)` | `pk_user_area_presence (user_id, area_id)`                                       |
| `area_id`    | `uuid`        | `fk_user_area_presence_area` → `areas.id`; `idx_user_area_presence_area`         |
| `entry_id`   | `uuid`        | `fk_user_area_presence_entry` → `area_entries.id`; `uq_user_area_presence_entry` |
| `entered_at` | `timestamptz` |                                                                                  |

The primary key `(user_id, area_id)` is the **idempotency guard** for entries: an entry is only written
if the presence row was actually inserted (`INSERT … ON CONFLICT DO NOTHING RETURNING`).
Autovacuum runs at a 1 % dead-tuple threshold on this table because rows are deleted on every exit.

### `user_tracking_state`

| Column               | Type          | Notes                                                             |
| -------------------- | ------------- | ----------------------------------------------------------------- |
| `user_id`            | `varchar(64)` | `pk_user_tracking_state`                                          |
| `last_transition_at` | `timestamptz` | client time of the latest entry/exit; written only on transitions |
| `updated_at`         | `timestamptz` | default `now()`                                                   |

### `outbox_events`

| Column         | Type               | Notes                                |
| -------------- | ------------------ | ------------------------------------ |
| `id`           | `uuid`             | `pk_outbox_events`; equals `eventId` |
| `topic`        | `varchar(249)`     | Kafka's topic name limit             |
| `message_key`  | `varchar(255)`     |                                      |
| `event_type`   | `varchar(100)`     |                                      |
| `payload`      | `jsonb`            | full envelope                        |
| `headers`      | `jsonb`            | default `'{}'`                       |
| `created_at`   | `timestamptz`      | default `now()`                      |
| `published_at` | `timestamptz` null |                                      |
| `attempts`     | `integer`          | default `0`                          |
| `last_error`   | `text` null        |                                      |

Indexes: `idx_outbox_events_unpublished (created_at, id) WHERE published_at IS NULL` (relay scan),
`idx_outbox_events_published_at (published_at) WHERE published_at IS NOT NULL` (retention cleanup).
Autovacuum runs at a 1 % dead-tuple threshold on this table.

### `idempotency_keys`

| Column         | Type           | Notes                                                           |
| -------------- | -------------- | --------------------------------------------------------------- |
| `scope`        | `varchar(64)`  | `pk_idempotency_keys (scope, key)`; e.g. `areas.create`         |
| `key`          | `varchar(128)` | value of the `Idempotency-Key` header                           |
| `resource_id`  | `uuid`         |                                                                 |
| `request_hash` | `char(64)`     | SHA-256 of the body; a different body with the same key → `422` |
| `created_at`   | `timestamptz`  | `idx_idempotency_keys_created_at`; expire after 24 h            |

## 8. Entry detection algorithm (worker)

For each batch consumed from `location.pings.v1`:

1. Decode and validate each message; invalid messages go to the DLQ immediately (no retry).
2. Group messages by `userId`, preserving partition order.
3. For each user, for each ping in order:
   1. `current = areaIndex.areasContaining(lon, lat)` — R-tree bbox search, then exact point-in-polygon (boundary = inside).
   2. Load `state = { areaIds, lastPingAt, lastTransitionAt }` from Redis; on miss or Redis failure load presence and
      `last_transition_at` from PostgreSQL.
   3. If `ping.timestamp <= max(lastPingAt, lastTransitionAt)` → skip (out of order / duplicate).
   4. If `lastPingAt` is known and `ping.timestamp - lastPingAt > PRESENCE_TTL_MS` → treat all previous areas as exited at `lastPingAt`.
   5. `entered = current − previous`, `exited = previous − current`.
   6. If there is no transition → update `lastPingAt` in Redis only. Done.
   7. Otherwise, delete the user's Redis key, then in **one PostgreSQL transaction**:
      - for each entered area: `INSERT INTO user_area_presence … ON CONFLICT DO NOTHING RETURNING`;
        only if a row was inserted → insert `area_entries` row and an `area.entered` outbox event;
      - for each exited area: `DELETE FROM user_area_presence … RETURNING entry_id`;
        only if a row was deleted → set `area_entries.exited_at` and insert an `area.exited` outbox event;
      - upsert `user_tracking_state.last_transition_at`.
   8. After commit, write the new state to Redis (TTL = `PRESENCE_TTL_MS`).
4. Commit Kafka offsets **only after** all database work for the batch has committed.

Failure handling:

- Transient errors (database / Redis timeouts) → retry the batch with exponential backoff, do not commit offsets.
  Kafka retains the messages; consumer lag grows and is alerted on.
- A message that fails `WORKER_MAX_ATTEMPTS` times with a non-transient error → DLQ with the error in headers.
- Duplicate delivery after a crash is harmless: the presence primary key and the `DELETE … RETURNING` guards make
  the processing idempotent, so no duplicate entries or events are produced.

Area index:

- Loaded fully from PostgreSQL at startup (worker is not ready until loaded).
- Refreshed on `area.created` events and fully reloaded every `AREA_INDEX_REFRESH_MS` (default 60 s) as a safety net.
- Pings processed in the short window between area creation and index refresh may miss the new area (documented eventual consistency).

## 9. Outbox relay

- Runs inside the worker role. Exactly one active relay at a time, elected with a PostgreSQL advisory lock
  (`pg_try_advisory_lock`); other instances stay on standby and retry the lock periodically.
  A single relay preserves per-key ordering of events.
- Loop: select up to `OUTBOX_BATCH_SIZE` unpublished rows ordered by `created_at, id`, publish them to Kafka
  (idempotent producer, `acks=all`), mark them `published_at = now()`. Sleep `OUTBOX_POLL_INTERVAL_MS` when idle.
- Publishing failures increment `attempts` and store `last_error`; the row is retried on the next loop.
- A crash after publish but before marking causes a re-publish → consumers deduplicate by `eventId`.
- Published rows older than `OUTBOX_RETENTION_MS` (default 7 d) are deleted by the relay.
- The same housekeeping deletes `idempotency_keys` rows older than 24 h.

## 10. Failure modes

| Failure                   | Behaviour                                                                                                                                             |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| Kafka unavailable         | API: `POST /locations` → `503` with `Retry-After`; readiness fails. Worker: consumption pauses; outbox rows accumulate and are published on recovery. |
| Redis unavailable         | Rate limiting fails **open**; worker reads/writes state from PostgreSQL only. Slower, still correct.                                                  |
| PostgreSQL unavailable    | Worker stops committing offsets and retries with backoff (no data loss, lag grows). `/areas` and `/logs` → `503`. `POST /locations` keeps working.    |
| Worker crash              | Partitions are rebalanced to other workers; uncommitted messages are redelivered and processed idempotently.                                          |
| Outbox relay leader crash | Advisory lock is released with its session; a standby instance takes over.                                                                            |
| Traffic spike             | API scales horizontally; Kafka absorbs bursts; workers scale up to the partition count; lag is the scaling signal.                                    |
| Malformed ping in Kafka   | Sent to DLQ, never blocks the partition.                                                                                                              |
| Invalid polygon           | `400` with the PostGIS validity reason.                                                                                                               |

## 11. Non-functional requirements

- **Latency:** `POST /locations` p99 < 50 ms at target load (excluding network).
- **Freshness:** ping → entry visible p99 < 1 s under normal load.
- **Graceful shutdown:** on `SIGTERM` stop accepting work, finish in-flight batches, commit offsets, flush the producer, close pools.
- **Observability:** JSON logs (one object per line on stdout) with `correlationId` on every line; Prometheus metrics for HTTP latency, pings produced/processed,
  entries/exits detected, processing latency, outbox backlog, DLQ count.
- **Configuration:** environment variables validated at startup; the process refuses to start on invalid configuration.
- **Security:** API key comparison in constant time; request body size limit; no stack traces or internal errors in responses.

## 12. Out of scope (v1)

- End-user authentication / authorization (delegated to the gateway).
- GPS noise filtering (hysteresis, minimum dwell time, accuracy thresholds).
- Area update / delete and the semantics of open presences on a changed area.
- Long-term raw location history and analytics.
- Batched ping ingestion endpoint for offline clients.
- Multi-region deployment.
- Background sweeper for presences of users who stopped sending pings (handled lazily, §3.8).

## 13. Milestones

| #   | Milestone                                                         | Status  |
| --- | ----------------------------------------------------------------- | ------- |
| 0   | Repository skeleton, tooling, config validation, Docker Compose   | done    |
| 1   | Database schema and migrations                                    | done    |
| 2   | Error handling, correlation id, structured logging, API key guard | done    |
| 3   | Areas API + outbox writer + idempotency keys                      | done    |
| 4   | Kafka module + `POST /locations` + rate limiting                  | planned |
| 5   | Worker: area index, entry detection, retries, DLQ                 | planned |
| 6   | Outbox relay + area index refresh                                 | planned |
| 7   | `GET /logs`                                                       | planned |
| 8   | Health, metrics, graceful shutdown                                | planned |
| 9   | Integration / e2e / load tests                                    | planned |
| 10  | README, ADRs, CI, Kubernetes manifests                            | planned |
