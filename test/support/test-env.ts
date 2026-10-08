import { DataSource } from 'typeorm';
import { inject } from 'vitest';
import { type Env, validateEnv } from '../../src/core/config/env.schema.js';
import { createDataSourceOptions } from '../../src/core/database/data-source-options.js';

/** A validated configuration pointing at the containers started by the global setup. */
export function testEnv(overrides: Record<string, string> = {}): Env {
  return validateEnv({
    NODE_ENV: 'test',
    LOG_LEVEL: 'silent',
    ...inject('databaseEnv'),
    ...overrides,
  });
}

/** An initialised TypeORM DataSource on the test database. The caller must destroy it. */
export async function createTestDataSource(): Promise<DataSource> {
  const dataSource = new DataSource(createDataSourceOptions(testEnv()));
  await dataSource.initialize();
  return dataSource;
}

/** Removes all rows from the service's tables, keeping the schema. */
export async function truncateAllTables(dataSource: DataSource): Promise<void> {
  await dataSource.query(`
    TRUNCATE TABLE user_area_presence, user_tracking_state, area_entries, areas,
                   outbox_events, idempotency_keys
    RESTART IDENTITY CASCADE
  `);
}
