import { pino } from 'pino';
import { loadEnv } from './core/config/load-env.js';
import { createBootstrapLogger } from './core/logging/bootstrap-logger.js';
import { createLoggerOptions } from './core/logging/logger-options.js';
import { provisionTopics } from './core/messaging/provision-topics.js';

/**
 * Kafka topic provisioning, executed as its own deployment step before the api and worker start
 * (the `provision-topics` service in docker compose), like the database migrations:
 *
 *   node dist/provision-topics.js
 *
 * Creates missing topics only, so running it repeatedly is harmless.
 */
let logger = createBootstrapLogger('provision-topics');

try {
  const env = loadEnv();
  logger = pino(createLoggerOptions(env, 'provision-topics'));
  const created = await provisionTopics(env, logger);
  logger.info({ created }, created.length === 0 ? 'Topics are up to date' : 'Topics created');
} catch (error) {
  logger.fatal({ err: error }, 'Topic provisioning failed');
  process.exitCode = 1;
}
