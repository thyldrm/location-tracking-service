import { existsSync } from 'node:fs';
import { validateEnv, type Env } from './env.schema.js';

/**
 * The only place that reads `process.env`.
 *
 * A local `.env` file is loaded when present (developer convenience). Variables already set in the
 * real environment take precedence, which is what container orchestrators rely on.
 */
export function loadEnv(envFilePath = '.env'): Env {
  if (existsSync(envFilePath)) {
    process.loadEnvFile(envFilePath);
  }
  return validateEnv(process.env);
}
