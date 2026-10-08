import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/**
 * Schema of every environment variable the service reads.
 *
 * The process refuses to start when the environment does not satisfy this schema
 * (fail fast), so misconfiguration surfaces at deploy time instead of at the first request.
 */
export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().min(1).default('location-tracking-service'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),

  HTTP_HOST: z.string().min(1).default('0.0.0.0'),
  // Optional: when unset each process role uses its own default (api 3000, worker 3001).
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  HTTP_TRUST_PROXY: booleanString.default(false),

  // Credentials have no defaults on purpose: a deployment that forgets them must not start.
  POSTGRES_HOST: z.string().min(1).default('localhost'),
  POSTGRES_PORT: z.coerce.number().int().min(1).max(65_535).default(5432),
  POSTGRES_USER: z.string().min(1),
  POSTGRES_PASSWORD: z.string().min(1),
  POSTGRES_DB: z.string().min(1),
  POSTGRES_SSL: booleanString.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(10),
  DB_CONNECT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(5_000),
  DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
});

export type Env = z.infer<typeof envSchema>;

/**
 * Parses raw environment variables into a typed, defaulted and coerced configuration.
 * Throws a single readable error that lists every invalid variable.
 */
export function validateEnv(raw: Record<string, unknown>): Env {
  const result = envSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
