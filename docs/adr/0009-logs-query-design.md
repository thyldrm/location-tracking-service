# ADR 0009 — `GET /logs`: query design

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

`GET /logs` lists the recorded area entries. At target load the table grows by hundreds of thousands of rows per day,
so a query that is fast on a test database can become the slowest endpoint of the service within weeks. Clients
filter by user, by area and by time, and page through results that keep changing while they read them (new
entries arrive every second).

## Decisions

### One index per access path, each ending in the sort order

The schema (ADR 0003) has three indexes: `(user_id, entered_at DESC, id DESC)`, `(area_id, entered_at DESC, id DESC)`
and `(entered_at DESC, id DESC)`. Every combination of filters is answered by one of them. The rows come out of the
index already in the response order, and PostgreSQL stops after `limit + 1` rows, however many match.

An integration test checks this with `EXPLAIN` on 60,000 analysed rows. It requires an ordered index scan with no Sort
node for no filter, an active user, an area and a time range. It also requires the cursor to be part of the index
condition, and rejects a sequential scan for any combination of filters. For a user with a handful of entries the
planner fetches them through the user index and sorts them, which is cheaper than walking the index in order. The test
allows that case.

Measured on one million rows in docker compose: every access path executes in 0.06–0.24 ms. For comparison,
`OFFSET 500000` takes 55 ms because it reads and discards half a million rows. Over HTTP, from inside the container,
p50 is 1.3–2.0 ms and p99 below 7 ms.

### Keyset pagination with a cursor bound to the filters

The cursor holds the sort key of the last item (`enteredAt`, `id`), like `GET /areas` (ADR 0005). `id` breaks ties
between entries with the same `enteredAt`, which are common: every user who enters an area with the same ping batch
can share a second.

The cursor also carries a 16-character digest of the filters. A cursor replayed with other filters would start the new
result at an arbitrary place without any error. It is rejected with `400` instead. `limit` is not part of the digest,
so a client may change the page size while paging.

### Strict query parameters

Unknown query parameters are rejected with `400` (SPEC §5.0). On a list endpoint a misspelled filter (`userID`) would
otherwise be ignored and return every user's entries: a wrong answer that looks right.

### No total count

Responses carry `nextCursor` but no total. `COUNT(*)` over a filter reads every matching row, which is exactly the cost
keyset pagination avoids. An approximate count (from planner statistics) can be added if a client needs one.

### Filters that match nothing return an empty page

`areaId` of an area that does not exist gives `200` with no items, not `404`. A filter describes a set, and an empty set
is a valid answer. Checking existence would add a query to every request.

## Consequences

- Adding a new filter means adding an index for it, or accepting that it is applied as a filter on one of the
  existing paths. The plan test makes the choice visible.
- The `+` of a timezone offset must be percent-encoded in a URL (`%2B03:00`); a raw `+` is decoded as a space and the
  value is rejected. `Z` needs no encoding.
- Entries appear in `GET /logs` once the worker has committed them (target p99 below 1 s after the ping). An open entry
  (`exitedAt: null`) changes when the user leaves; a client that paged past it does not see that change unless it
  reads again.
