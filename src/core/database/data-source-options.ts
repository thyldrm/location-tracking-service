import type { DataSourceOptions } from 'typeorm';
import type { Env } from '../config/env.schema.js';
import { entities } from './entities.js';
import { migrations } from './migrations/index.js';

export type DatabaseEnv = Pick<
  Env,
  | 'SERVICE_NAME'
  | 'POSTGRES_HOST'
  | 'POSTGRES_PORT'
  | 'POSTGRES_USER'
  | 'POSTGRES_PASSWORD'
  | 'POSTGRES_DB'
  | 'POSTGRES_SSL'
  | 'DB_POOL_MAX'
  | 'DB_CONNECT_TIMEOUT_MS'
  | 'DB_STATEMENT_TIMEOUT_MS'
  | 'DB_IDLE_IN_TRANSACTION_TIMEOUT_MS'
>;

/**
 * Single definition of how the service connects to PostgreSQL, shared by the Nest application
 * and the standalone migration runner.
 */
export function createDataSourceOptions(env: DatabaseEnv): DataSourceOptions {
  return {
    type: 'postgres',
    host: env.POSTGRES_HOST,
    port: env.POSTGRES_PORT,
    username: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DB,
    ssl: env.POSTGRES_SSL ? { rejectUnauthorized: true } : false,
    // Shows up in pg_stat_activity, which makes it obvious which service owns a connection.
    applicationName: env.SERVICE_NAME,
    connectTimeoutMS: env.DB_CONNECT_TIMEOUT_MS,

    entities,
    migrations,
    migrationsTableName: 'schema_migrations',
    migrationsTransactionMode: 'each',
    // The schema changes only through reviewed migrations, run as a separate deployment step.
    synchronize: false,
    migrationsRun: false,

    extra: {
      max: env.DB_POOL_MAX,
      // Server-side guards: a runaway query or a forgotten open transaction cannot hold
      // locks and connections indefinitely.
      statement_timeout: env.DB_STATEMENT_TIMEOUT_MS,
      idle_in_transaction_session_timeout: env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS,
      idleTimeoutMillis: 30_000,
    },
  };
}
