# ADR 0007 — Worker: entry detection, idempotency and failure handling

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

The worker turns ~10,000 pings/s into a few entries and exits per second. Kafka delivers at least once: after a crash
or a rebalance, messages are processed again. Dependencies fail: the database restarts, Redis loses its data, and
some messages are simply malformed. Whatever happens, an entry must be recorded exactly once, ordering per user must
hold, and one bad message must not stop the processing of millions of good ones.

## Decisions

### In-memory area index

Areas are few and change rarely; pings are many. Each worker keeps every area in memory: a packed R-tree (Flatbush)
of bounding boxes selects candidates, an exact point-in-polygon test confirms them. No database round trip per ping.
Boundary points count as inside, like `ST_Covers`; an integration test compares the implementation with PostGIS on
thousands of points, including vertices and edges. The index is rebuilt and swapped atomically on each reload, and the
consumer starts only after the first load (an empty index would exit every user from every area).

### State in Redis, truth in PostgreSQL

Most pings change nothing. Their state (current areas, last ping time) lives in Redis, so they cost one Redis read and
one write and nothing in PostgreSQL. Only transitions touch the database. Redis is a cache-aside store: on a miss or a
failure the state is rebuilt from `user_area_presence` and `user_tracking_state`.

A wrong cached state cannot create wrong data, because the database decides what is written:

- an entry is recorded only if `INSERT INTO user_area_presence … ON CONFLICT DO NOTHING RETURNING` inserted a row;
- an exit only if `DELETE FROM user_area_presence … RETURNING` deleted one;
- the transition watermark only moves forward.

The presence row is inserted before the entry it references, which requires the foreign key to be checked at commit
(`DEFERRABLE INITIALLY DEFERRED`). Alternatives were an extra existence check (a check-then-act race) or inserting
the entry first and deleting it on conflict (wasted writes on every duplicate).

The cached state lives 24 h (`PRESENCE_STATE_TTL_MS`), not 15 min: with the presence TTL as cache TTL, the last ping
time would expire exactly when it is needed to detect a stale session.

### Inbox not needed

A generic inbox table (one row per processed message id) would add a write for every ping, ~10,000/s, to protect
against duplicates that the natural keys above already absorb.

### Ordering and concurrency

Partitions are keyed by user id; one partition is processed by one consumer at a time. Within a batch, users are
processed concurrently and the pings of a user sequentially. A ping not newer than the user's last processed ping or
transition is ignored. When a transient failure aborts a batch, the handler waits for every user of that batch to
finish before the batch is redelivered, so the redelivery never runs alongside unfinished work.

### Failure handling

| Failure                                         | Handling                                                               | Why                                                                                                                   |
| ----------------------------------------------- | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Invalid message                                 | Dead letter topic immediately                                          | It can never succeed; retrying would block the partition.                                                             |
| Transient (database or network down, timeouts)  | Redeliver the batch after back-off with jitter, 0.5 s doubling to 30 s | Nothing is lost; lag grows and recovers by itself. Without back-off the client redelivers instantly, in a tight loop. |
| Other errors (e.g. a bug triggered by one ping) | Retry 3 times, then dead letter with the error                         | Bounded: one bad ping does not stop the partition.                                                                    |

Dead-lettered messages keep their original key, value and headers, plus the reason, the error and the original
position, so they can be replayed after a fix. Transient errors are recognised by SQLSTATE codes, socket error codes
and the `pg` driver's messages for lost connections, observed by stopping and freezing the database container. The
same classification makes the API answer `503` instead of `500`.

## Consequences

- At-least-once processing with exactly-once effects in PostgreSQL; downstream consumers of `area.entries.v1`
  deduplicate by `eventId` (relay redelivery, milestone 6).
- A database outage stops entry detection but loses nothing; recovery is automatic.
- If Redis loses its data, a stale session that ended during the loss is not detected (documented degraded mode).
- Back-off is per worker instance, not per partition: during an outage all partitions of an instance slow down together,
  which is what we want.
- Kafka's own client logs every failed batch with a stack trace; the back-off bounds this to a few lines per minute
  per instance.
