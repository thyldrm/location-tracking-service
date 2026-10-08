import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Initial schema. See SPEC.md §7 for the meaning of every table.
 *
 * Written by hand rather than generated: PostGIS types, functional, descending and partial indexes
 * and check constraints are expressed exactly, and every constraint has a stable, readable name.
 */
export class InitialSchema1791450000000 implements MigrationInterface {
  name = 'InitialSchema1791450000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS postgis`);

    await queryRunner.query(`
      CREATE TABLE areas (
        id          uuid                    NOT NULL,
        name        varchar(120)            NOT NULL,
        description text                    NULL,
        geometry    geometry(Polygon, 4326) NOT NULL,
        created_at  timestamptz             NOT NULL DEFAULT now(),
        updated_at  timestamptz             NOT NULL DEFAULT now(),
        CONSTRAINT pk_areas PRIMARY KEY (id),
        CONSTRAINT chk_areas_geometry_valid CHECK (ST_IsValid(geometry)),
        CONSTRAINT chk_areas_name_not_blank CHECK (btrim(name) <> '')
      )
    `);
    // Names are unique regardless of case ("Kadikoy" and "kadikoy" are the same area).
    await queryRunner.query(`CREATE UNIQUE INDEX uq_areas_name_lower ON areas (lower(name))`);
    // GiST index: bounding-box search for spatial predicates such as ST_Covers / ST_Intersects.
    await queryRunner.query(`CREATE INDEX idx_areas_geometry ON areas USING gist (geometry)`);
    // Keyset pagination for GET /areas (newest first).
    await queryRunner.query(
      `CREATE INDEX idx_areas_created_at_id ON areas (created_at DESC, id DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE area_entries (
        id         uuid        NOT NULL,
        user_id    varchar(64) NOT NULL,
        area_id    uuid        NOT NULL,
        entered_at timestamptz NOT NULL,
        exited_at  timestamptz NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_area_entries PRIMARY KEY (id),
        CONSTRAINT fk_area_entries_area FOREIGN KEY (area_id) REFERENCES areas (id) ON DELETE RESTRICT,
        CONSTRAINT chk_area_entries_exit_after_entry CHECK (exited_at IS NULL OR exited_at >= entered_at)
      )
    `);
    // One index per GET /logs access path; each ends with (entered_at DESC, id DESC) for keyset pagination.
    await queryRunner.query(
      `CREATE INDEX idx_area_entries_user_entered ON area_entries (user_id, entered_at DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_area_entries_area_entered ON area_entries (area_id, entered_at DESC, id DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX idx_area_entries_entered ON area_entries (entered_at DESC, id DESC)`,
    );

    await queryRunner.query(`
      CREATE TABLE user_area_presence (
        user_id    varchar(64) NOT NULL,
        area_id    uuid        NOT NULL,
        entry_id   uuid        NOT NULL,
        entered_at timestamptz NOT NULL,
        CONSTRAINT pk_user_area_presence PRIMARY KEY (user_id, area_id),
        CONSTRAINT fk_user_area_presence_area FOREIGN KEY (area_id) REFERENCES areas (id) ON DELETE RESTRICT,
        CONSTRAINT fk_user_area_presence_entry FOREIGN KEY (entry_id) REFERENCES area_entries (id) ON DELETE RESTRICT
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX uq_user_area_presence_entry ON user_area_presence (entry_id)`,
    );
    // Foreign key columns are indexed so that checks on the referenced side never scan this table.
    await queryRunner.query(
      `CREATE INDEX idx_user_area_presence_area ON user_area_presence (area_id)`,
    );

    await queryRunner.query(`
      CREATE TABLE user_tracking_state (
        user_id            varchar(64) NOT NULL,
        last_transition_at timestamptz NOT NULL,
        updated_at         timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT pk_user_tracking_state PRIMARY KEY (user_id)
      )
    `);

    await queryRunner.query(`
      CREATE TABLE outbox_events (
        id           uuid         NOT NULL,
        topic        varchar(249) NOT NULL,
        message_key  varchar(255) NOT NULL,
        event_type   varchar(100) NOT NULL,
        payload      jsonb        NOT NULL,
        headers      jsonb        NOT NULL DEFAULT '{}'::jsonb,
        created_at   timestamptz  NOT NULL DEFAULT now(),
        published_at timestamptz  NULL,
        attempts     integer      NOT NULL DEFAULT 0,
        last_error   text         NULL,
        CONSTRAINT pk_outbox_events PRIMARY KEY (id)
      )
    `);
    // The relay only ever scans unpublished rows: a partial index keeps that scan tiny.
    await queryRunner.query(
      `CREATE INDEX idx_outbox_events_unpublished ON outbox_events (created_at, id) WHERE published_at IS NULL`,
    );
    // Retention cleanup of published rows.
    await queryRunner.query(
      `CREATE INDEX idx_outbox_events_published_at ON outbox_events (published_at) WHERE published_at IS NOT NULL`,
    );

    await queryRunner.query(`
      CREATE TABLE idempotency_keys (
        scope        varchar(64)  NOT NULL,
        key          varchar(128) NOT NULL,
        resource_id  uuid         NOT NULL,
        request_hash char(64)     NOT NULL,
        created_at   timestamptz  NOT NULL DEFAULT now(),
        CONSTRAINT pk_idempotency_keys PRIMARY KEY (scope, key)
      )
    `);
    await queryRunner.query(
      `CREATE INDEX idx_idempotency_keys_created_at ON idempotency_keys (created_at)`,
    );

    // High-churn queue-like tables: vacuum them far more eagerly than the 20 % default so that
    // dead tuples left by deletes and updates do not bloat the tables and their indexes.
    for (const table of ['outbox_events', 'user_area_presence']) {
      await queryRunner.query(
        `ALTER TABLE ${table} SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_analyze_scale_factor = 0.02)`,
      );
    }
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE IF EXISTS idempotency_keys`);
    await queryRunner.query(`DROP TABLE IF EXISTS outbox_events`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_tracking_state`);
    await queryRunner.query(`DROP TABLE IF EXISTS user_area_presence`);
    await queryRunner.query(`DROP TABLE IF EXISTS area_entries`);
    await queryRunner.query(`DROP TABLE IF EXISTS areas`);
    // The postgis extension is intentionally kept: it is database-wide and may be used by others.
  }
}
