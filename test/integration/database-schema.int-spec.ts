import type { DataSource } from 'typeorm';
import { migrations } from '../../src/core/database/migrations/index.js';
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

  it('can revert every migration and apply them again', async () => {
    const tableExists = async (): Promise<boolean> => {
      const rows: Array<{ exists: boolean }> = await dataSource.query(
        `SELECT to_regclass('public.areas') IS NOT NULL AS exists`,
      );
      return rows[0]?.exists ?? false;
    };

    // Exercises every down(), newest first, then every up() again.
    for (let index = 0; index < migrations.length; index++) {
      await dataSource.undoLastMigration({ transaction: 'each' });
    }
    expect(await tableExists()).toBe(false);

    const applied = await dataSource.runMigrations({ transaction: 'each' });
    expect(applied.map((migration) => migration.name)).toEqual(
      migrations.map((migration) => migration.name),
    );
    expect(await tableExists()).toBe(true);
    const pending = await dataSource.driver.createSchemaBuilder().log();
    expect(pending.upQueries).toEqual([]);
  });
});
