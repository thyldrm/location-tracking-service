import { existsSync } from 'node:fs';
import { validateEnv, type Env } from './env.schema.js';

/**
 * The only place that reads `process.env`.
 *
 * A local `.env` file is loaded when present (developer convenience). Variables already set in the
 * real environment take precedence, which is what container orchestrators rely on.
 */
export function loadEnv(envFilePath = '.env'): Env {
  const envFileExists = existsSync(envFilePath);
  if (envFileExists) {
    process.loadEnvFile(envFilePath);
  }

  try {
    return validateEnv(process.env);
  } catch (error) {
    if (!envFileExists && error instanceof Error) {
      throw new Error(
        `${error.message}\n\nNo ${envFilePath} file was found. ` +
          'For local development, copy .env.example to .env.',
        { cause: error },
      );
    }
    throw error;
  }
}
