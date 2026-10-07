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
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
  HTTP_TRUST_PROXY: booleanString.default(false),
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
