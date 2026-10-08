import type { DataSource } from 'typeorm';
import { createTestDataSource } from '../support/test-env.js';

describe('Database schema (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('has applied every migration, so running them again is a no-op', async () => {
    const applied = await dataSource.runMigrations({ transaction: 'each' });

    expect(applied).toEqual([]);
  });

  it('matches the entity mappings exactly (no schema drift)', async () => {
    // Asks TypeORM which statements it would run to make the database match the entities.
    // Any statement means a migration and an entity disagree.
    const pending = await dataSource.driver.createSchemaBuilder().log();

    expect(pending.upQueries.map((query) => query.query)).toEqual([]);
  });

  it('can revert and re-apply the latest migration', async () => {
    const tableExists = async (): Promise<boolean> => {
      const rows: Array<{ exists: boolean }> = await dataSource.query(
        `SELECT to_regclass('public.areas') IS NOT NULL AS exists`,
      );
      return rows[0]?.exists ?? false;
    };

    await dataSource.undoLastMigration({ transaction: 'each' });
    expect(await tableExists()).toBe(false);

    await dataSource.runMigrations({ transaction: 'each' });
    expect(await tableExists()).toBe(true);
  });
});
