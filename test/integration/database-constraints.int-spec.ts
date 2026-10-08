import { randomUUID } from 'node:crypto';
import { QueryFailedError, type DataSource } from 'typeorm';
import { createTestDataSource, truncateAllTables } from '../support/test-env.js';

/** A 0.01° square around (29.03, 40.99) as WKT, longitude first. */
const SQUARE = 'POLYGON((29.02 40.98, 29.04 40.98, 29.04 41.00, 29.02 41.00, 29.02 40.98))';
/** Self-intersecting "bow tie": a structurally valid ring that is not a valid polygon. */
const BOW_TIE = 'POLYGON((29.02 40.98, 29.04 41.00, 29.04 40.98, 29.02 41.00, 29.02 40.98))';

/** Asserts that a query failed with the given PostgreSQL SQLSTATE and, optionally, constraint name. */
async function expectPgError(promise: Promise<unknown>, code: string, constraint?: string) {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  if (!(error instanceof QueryFailedError)) {
    throw new Error(`Expected a QueryFailedError, got: ${String(error)}`);
  }
  expect(error.driverError).toMatchObject(constraint ? { code, constraint } : { code });
}

async function spatialPredicate(
  dataSource: DataSource,
  predicate: 'ST_Covers' | 'ST_Contains',
  lon: number,
  lat: number,
): Promise<boolean | undefined> {
  const rows: Array<{ result: boolean }> = await dataSource.query(
    `SELECT ${predicate}(ST_GeomFromText($1, 4326), ST_SetSRID(ST_MakePoint($2, $3), 4326)) AS result`,
    [SQUARE, lon, lat],
  );
  return rows[0]?.result;
}

describe('Database constraints (integration)', () => {
  let dataSource: DataSource;

  const insertArea = (name: string, wkt = SQUARE, srid = 4326, id = randomUUID()) =>
    dataSource
      .query(`INSERT INTO areas (id, name, geometry) VALUES ($1, $2, ST_GeomFromText($3, $4))`, [
        id,
        name,
        wkt,
        srid,
      ])
      .then(() => id);

  const insertEntry = (areaId: string, enteredAt: string, exitedAt: string | null = null) =>
    dataSource
      .query(
        `INSERT INTO area_entries (id, user_id, area_id, entered_at, exited_at) VALUES ($1, 'u-1', $2, $3, $4)`,
        [randomUUID(), areaId, enteredAt, exitedAt],
      )
      .then(() => undefined);

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  beforeEach(async () => {
    await truncateAllTables(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  describe('areas', () => {
    it('accepts a valid polygon', async () => {
      await expect(insertArea('Kadikoy')).resolves.toBeTypeOf('string');
    });

    it('rejects a self-intersecting polygon', async () => {
      await expectPgError(insertArea('Bow tie', BOW_TIE), '23514', 'chk_areas_geometry_valid');
    });

    it('rejects a geometry that is not a polygon', async () => {
      // 22023 = invalid_parameter_value: the geometry(Polygon, 4326) type modifier refuses a point.
      await expectPgError(insertArea('A point', 'POINT(29.03 40.99)'), '22023');
    });

    it('rejects a polygon in another coordinate reference system', async () => {
      await expectPgError(insertArea('Web Mercator', SQUARE, 3857), '22023');
    });

    it('treats names case-insensitively when enforcing uniqueness', async () => {
      await insertArea('Kadikoy');

      await expectPgError(insertArea('KADIKOY'), '23505', 'uq_areas_name_lower');
    });

    it('rejects a blank name', async () => {
      await expectPgError(insertArea('   '), '23514', 'chk_areas_name_not_blank');
    });
  });

  describe('area_entries', () => {
    it('rejects an exit earlier than the entry', async () => {
      const areaId = await insertArea('Kadikoy');

      await expectPgError(
        insertEntry(areaId, '2026-10-08T10:00:00Z', '2026-10-08T09:59:59Z'),
        '23514',
        'chk_area_entries_exit_after_entry',
      );
    });

    it('rejects an entry for an unknown area', async () => {
      await expectPgError(
        insertEntry(randomUUID(), '2026-10-08T10:00:00Z'),
        '23503',
        'fk_area_entries_area',
      );
    });
  });

  describe('user_area_presence', () => {
    it('lets ON CONFLICT DO NOTHING detect that the user is already inside (idempotency guard)', async () => {
      const areaId = await insertArea('Kadikoy');
      const entryId = randomUUID();
      await dataSource.query(
        `INSERT INTO area_entries (id, user_id, area_id, entered_at) VALUES ($1, 'u-1', $2, now())`,
        [entryId, areaId],
      );

      const insertPresence = async (): Promise<unknown[]> => {
        const rows: unknown[] = await dataSource.query(
          `INSERT INTO user_area_presence (user_id, area_id, entry_id, entered_at)
           VALUES ('u-1', $1, $2, now())
           ON CONFLICT (user_id, area_id) DO NOTHING
           RETURNING user_id`,
          [areaId, entryId],
        );
        return rows;
      };

      expect(await insertPresence()).toHaveLength(1); // first delivery: row created → record the entry
      expect(await insertPresence()).toHaveLength(0); // redelivery: nothing created → no duplicate entry
    });
  });

  describe('PostGIS boundary semantics (documents SPEC §3.6)', () => {
    it('counts a point on the boundary as inside with ST_Covers but not with ST_Contains', async () => {
      expect(await spatialPredicate(dataSource, 'ST_Covers', 29.02, 40.99)).toBe(true);
      expect(await spatialPredicate(dataSource, 'ST_Contains', 29.02, 40.99)).toBe(false);
    });

    it('agrees on interior and exterior points', async () => {
      expect(await spatialPredicate(dataSource, 'ST_Covers', 29.03, 40.99)).toBe(true);
      expect(await spatialPredicate(dataSource, 'ST_Covers', 29.05, 40.99)).toBe(false);
    });
  });
});
