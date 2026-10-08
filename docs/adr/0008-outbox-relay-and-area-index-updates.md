# ADR 0008 — Outbox relay, area index updates and housekeeping

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

Entries, exits and created areas are written to `outbox_events` in the transaction of the state change (ADR 0005,
ADR 0007). Something has to publish those rows to Kafka: exactly what was committed, in order per key, without
losing events when Kafka, PostgreSQL or the relay itself fails. Several worker instances run at the same time and
any of them may crash, be restarted or freeze.

The worker also needs to know new areas quickly. Until now it reloaded the whole table every 60 s, so a new area was
invisible for up to a minute.

Finally, published outbox rows and idempotency keys accumulate forever unless something deletes them.

## Decisions

### One relay at a time, elected per pass with a transaction-level advisory lock

Each relay pass is one transaction that starts with `pg_try_advisory_xact_lock`. The instance that gets it reads the
oldest unpublished rows, publishes them, marks them and commits, which releases the lock. The others are on standby
and try again at their next poll (500 ms).

The lock ends with the transaction, whatever ends it:

| What happens to the relay           | When the lock is released                                                            |
| ----------------------------------- | ------------------------------------------------------------------------------------ |
| Pass completes                      | At commit                                                                            |
| Process crashes                     | Immediately: the operating system closes the socket                                  |
| Host freezes or becomes unreachable | After `idle_in_transaction_session_timeout` (10 s), when PostgreSQL ends the session |

Alternatives:

- **A session-level lock held for the whole leadership** (the original plan in SPEC §9). A frozen or unreachable
  leader keeps its session, and the lock, until TCP keepalive notices: two hours with Linux defaults. It also needs
  a dedicated connection and an "am I still the leader?" check before every pass. The transaction-level lock gets
  bounded failover from a timeout that is already configured.
- **Several relays with `FOR UPDATE SKIP LOCKED`.** More throughput, but two relays can publish two events of the same
  user concurrently, in either order. Per-key ordering would then need sharding by key (one lock per shard), which
  is not needed at a few events per second.
- **Change data capture (Debezium reading the WAL).** No polling and no relay code, but a Kafka Connect cluster to
  operate, plus replication slots that retain WAL when the connector stops. Too much infrastructure for this volume.

Measured in docker compose with two workers: the leader was frozen (`docker pause`) while waiting for Kafka inside its
transaction. PostgreSQL ended its session 10 s after the transaction went idle, and the other worker published the
event 263 ms later.

### Order per key, failures per key

Within a pass, rows with the same message key are published one after another, each after the previous one was
acknowledged; the first failure stops that key until the next pass. Different keys are published concurrently. The
alternative, sending the whole batch at once and marking what succeeded, is faster but can publish a user's second event
before a retry of the first.

Rows are always selected as `published_at IS NULL`, never as "newer than the last row seen". `created_at` is the
start time of the writing transaction, so a transaction that commits late can add a row older than rows already
published; a high-water mark would skip it forever.

### Failure classification

- **Kafka unavailable or slow** (`unavailable`, `timeout`, `queue-full`): the rows are left as they are and the relay
  backs off (0.5 s doubling to 30 s, with jitter). An outage of any length uses up no attempts. Measured: a 40 s Kafka
  outage left the row at `attempts = 0`, and it was published 20 s after Kafka came back (the back-off interval at the time).
- **Rejected by the broker**, or the row names an unknown topic: `attempts + 1` and `last_error`. After
  `OUTBOX_MAX_ATTEMPTS` (10) the row is parked: it is no longer selected, so it cannot block the relay, and it stays
  in the table for an operator. Later events with the same key are then published without it.

The relay waits for Kafka inside its transaction. A pass waits at most `KAFKA_DELIVERY_TIMEOUT_MS` (3 s) per send,
which must stay below `DB_IDLE_IN_TRANSACTION_TIMEOUT_MS` (10 s); configuration validation refuses anything else. The
transaction holds no row locks, only the advisory lock, so waiting in it blocks no other writer.

### Polling, not `LISTEN/NOTIFY`

The relay polls every 500 ms, and immediately again after a full batch. An empty poll is one index lookup. `NOTIFY`
would save the polling delay but does not work through PgBouncer in transaction pooling mode, and a missed
notification would still need polling as a fallback.

### Area index updates from `area.created`

Every worker instance consumes `area.lifecycle.v1` in a consumer group of its own (broadcast instead of a work
queue). The group is new on every start, reads the topic from the beginning and never commits, so it leaves nothing
behind. Replaying the retained events closes the gap between the startup load of the table and the first event
the consumer sees. Areas never change after creation (updates and deletes are out of scope), so a replayed event is
skipped.

The event carries the geometry (event-carried state transfer): the area is added without a database read, so the
number of worker instances does not multiply the load on PostgreSQL.

Reloads and event additions are queued one after another. Without this, a reload that read the table just before an
area was committed could finish after that area's event was applied, and drop the area until the next reload; a
unit test reproduces that interleaving. The periodic reload stays as reconciliation for a missed or invalid event.

Measured: a new area was in the index 117 ms after its creation request was committed.

### Housekeeping

The worker deletes published outbox rows after 7 days (`OUTBOX_RETENTION_MS`) and idempotency keys after 24 h
(`IDEMPOTENCY_KEY_TTL_MS`), at startup and every 10 minutes. Rows are deleted in chunks of 1,000, one short
transaction each, oldest first through the existing indexes. One `DELETE` of millions of rows would hold its
transaction for a long time and produce a burst of WAL and dead rows. Every chunk takes a transaction-level advisory
lock; an instance that does not get it skips the run. Unpublished events are never deleted.

## Consequences

- Delivery is at least once. In the freeze test above, the frozen leader still delivered its buffered message after it
  was resumed, and the new leader published the same event again: two copies of one `area.created` in Kafka.
  Consumers deduplicate by `eventId`; the area index skips an area it already has.
- Event latency is the poll interval plus one round trip to Kafka: 0.1–0.5 s measured.
- One relay at a time bounds throughput to roughly one batch (100 events) per Kafka round trip, thousands of events
  per second. If that ever becomes a limit, the next step is sharding the outbox by key hash with one lock per shard.
- Parked events are a silent failure without alerting. A metric for them and for the unpublished backlog is part of
  milestone 8.
- Each relay pass uses one pooled connection for a few milliseconds, up to a few seconds while Kafka is slow.
