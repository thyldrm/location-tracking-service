import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { DataSource } from 'typeorm';
import type { TestProject } from 'vitest/node';
import { validateEnv } from '../../src/core/config/env.schema.js';
import { createDataSourceOptions } from '../../src/core/database/data-source-options.js';

/** Same image as docker-compose.yml, so tests run against the production database engine. */
const POSTGIS_IMAGE = 'postgis/postgis:18-3.6-alpine';

export type DatabaseTestEnv = {
  POSTGRES_HOST: string;
  POSTGRES_PORT: string;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
};

declare module 'vitest' {
  export interface ProvidedContext {
    databaseEnv: DatabaseTestEnv;
  }
}

/**
 * Starts the infrastructure once for the whole integration run, applies the migrations and hands the
 * connection details to the test files through `inject('databaseEnv')`.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const postgres: StartedPostgreSqlContainer = await new PostgreSqlContainer(POSTGIS_IMAGE)
    .withDatabase('location_tracking_test')
    .withUsername('test')
    .withPassword('test')
    .start();

  const databaseEnv: DatabaseTestEnv = {
    POSTGRES_HOST: postgres.getHost(),
    POSTGRES_PORT: String(postgres.getPort()),
    POSTGRES_USER: postgres.getUsername(),
    POSTGRES_PASSWORD: postgres.getPassword(),
    POSTGRES_DB: postgres.getDatabase(),
  };

  const dataSource = new DataSource(
    createDataSourceOptions(validateEnv({ NODE_ENV: 'test', ...databaseEnv })),
  );
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });
  await dataSource.destroy();

  project.provide('databaseEnv', databaseEnv);

  return async () => {
    await postgres.stop();
  };
}
