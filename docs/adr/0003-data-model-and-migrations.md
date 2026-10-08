# ADR 0003 — Data model, PostGIS and migrations

- **Status:** Accepted
- **Date:** 2026-10-08

## Context

The case leaves the polygon data model and storage to the developer and requires PostgreSQL with
TypeORM or Prisma. Area entries grow without bound; presence state changes on every entry and exit.

## Decisions

### Polygons: GeoJSON in, PostGIS `geometry(Polygon, 4326)` stored

- GeoJSON (RFC 7946) is what mobile and web clients already speak; positions are `[longitude, latitude]`.
- PostGIS gives a real polygon type, validity checks (`ST_IsValid`) and GiST indexes. Storing coordinates as JSON or
  arrays would push validation and spatial search into application code.
- `geometry` with SRID 4326 instead of `geography`: point-in-polygon on city-scale areas is accurate with planar
  math and much cheaper. `geography` matters for distances and areas spanning large parts of the globe, which v1 does not need.
- The column's type modifier rejects non-polygons and other SRIDs, and `chk_areas_geometry_valid` rejects invalid
  shapes (e.g. self-intersections) even if a bug bypasses application validation.

### TypeORM over Prisma

TypeORM maps PostGIS geometry columns to GeoJSON natively and exposes explicit transactions and query runners,
which the outbox and entry detection need. Prisma would require `Unsupported("geometry")` and raw SQL for every
spatial read and write.

### Hand-written migrations, run as a separate step

- Migrations are written in SQL rather than generated, so PostGIS types, functional (`lower(name)`), descending and
  partial indexes, check constraints and storage parameters are exactly what we intend, with stable constraint names.
- `synchronize` is never enabled. Changing an entity column with `synchronize` on can drop and recreate the column
  (data loss); the schema-drift test demonstrates this.
- Migrations run in their own process (`dist/migrate.js`: a Kubernetes Job / init container, the `migrate` service in
  compose) instead of on application start. Many replicas starting at once would otherwise race; a PostgreSQL
  advisory lock additionally serialises accidental concurrent runs.
- An integration test compares entities with the migrated schema and fails on any drift.

### Identifiers: application-generated UUIDv7

The id of an entry must be known before the transaction commits, because the outbox event written in the same
transaction references it. UUIDv7 is time-ordered, so inserts append to the right edge of B-tree indexes like an
auto-increment key, while still being generated without coordination.

### Presence as its own table

Open visits could be derived from `area_entries WHERE exited_at IS NULL`, but a separate, small `user_area_presence`
table keeps `area_entries` append-mostly and partitionable by time later, and its primary key is the idempotency guard
of entry detection.

## Consequences

- Every schema change needs a migration **and** a matching entity change; CI catches mismatches.
- Deployments run the migration job before rolling out new pods; migrations must stay backward compatible with the
  previous application version (expand → migrate → contract).
