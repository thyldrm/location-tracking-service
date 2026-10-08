import { Logger } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { loadEnv } from './core/config/load-env.js';
import { AdvisoryLock, withAdvisoryLock } from './core/database/advisory-locks.js';
import { createDataSourceOptions } from './core/database/data-source-options.js';

/**
 * Migration runner, executed as its own deployment step (Kubernetes Job / init container,
 * the `migrate` service in docker compose) before new application pods start.
 *
 *   node dist/migrate.js           apply pending migrations
 *   node dist/migrate.js revert    revert the most recent migration
 *
 * An advisory lock serialises concurrent runners, so starting several by mistake is harmless.
 */
const logger = new Logger('Migrations');
const command = process.argv[2] ?? 'run';

if (command !== 'run' && command !== 'revert') {
  logger.error(`Unknown command "${command}". Use "run" or "revert".`);
  process.exit(2);
}

const dataSource = new DataSource(createDataSourceOptions(loadEnv()));

try {
  await dataSource.initialize();
  await withAdvisoryLock(dataSource, AdvisoryLock.Migrations, async () => {
    if (command === 'revert') {
      await dataSource.undoLastMigration({ transaction: 'each' });
      logger.log('Reverted the most recent migration');
      return;
    }
    const applied = await dataSource.runMigrations({ transaction: 'each' });
    logger.log(
      applied.length === 0
        ? 'Schema is up to date'
        : `Applied ${applied.length} migration(s): ${applied.map((m) => m.name).join(', ')}`,
    );
  });
} catch (error) {
  logger.error('Migration failed', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
} finally {
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
}
