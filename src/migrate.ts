import { pino } from 'pino';
import { DataSource } from 'typeorm';
import { loadEnv } from './core/config/load-env.js';
import { AdvisoryLock, withAdvisoryLock } from './core/database/advisory-locks.js';
import { createDataSourceOptions } from './core/database/data-source-options.js';
import { createBootstrapLogger } from './core/logging/bootstrap-logger.js';
import { createLoggerOptions } from './core/logging/logger-options.js';

/**
 * Migration runner, executed as its own deployment step (Kubernetes Job / init container,
 * the `migrate` service in docker compose) before new application pods start.
 *
 *   node dist/migrate.js           apply pending migrations
 *   node dist/migrate.js revert    revert the most recent migration
 *
 * An advisory lock serialises concurrent runners, so starting several by mistake is harmless.
 */
let logger = createBootstrapLogger('migrate');
const command = process.argv[2] ?? 'run';

if (command !== 'run' && command !== 'revert') {
  logger.error(`Unknown command "${command}". Use "run" or "revert".`);
  process.exit(2);
}

let dataSource: DataSource | undefined;

try {
  const env = loadEnv();
  logger = pino(createLoggerOptions(env, 'migrate'));
  dataSource = new DataSource(createDataSourceOptions(env));
  await dataSource.initialize();

  const connected = dataSource;
  await withAdvisoryLock(connected, AdvisoryLock.Migrations, async () => {
    if (command === 'revert') {
      await connected.undoLastMigration({ transaction: 'each' });
      logger.info('Reverted the most recent migration');
      return;
    }
    const applied = await connected.runMigrations({ transaction: 'each' });
    logger.info(
      { applied: applied.map((migration) => migration.name) },
      applied.length === 0 ? 'Schema is up to date' : `Applied ${applied.length} migration(s)`,
    );
  });
} catch (error) {
  logger.fatal({ err: error }, 'Migration failed');
  process.exitCode = 1;
} finally {
  if (dataSource?.isInitialized) {
    await dataSource.destroy();
  }
}
