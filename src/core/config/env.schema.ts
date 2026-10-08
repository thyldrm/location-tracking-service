import { z } from 'zod';

const booleanString = z.enum(['true', 'false']).transform((value) => value === 'true');

/** `a, b,c` → `['a', 'b', 'c']`; blank entries are dropped. */
const commaSeparatedList = z.string().transform((value) =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
);

/** Comma-separated list of service API keys. Several keys may be active at once (key rotation). */
const apiKeyList = z
  .string()
  .default('')
  .pipe(commaSeparatedList)
  .pipe(z.array(z.string().min(32, 'each API key must be at least 32 characters long')));

/**
 * Schema of every environment variable the service reads.
 *
 * The process refuses to start when the environment does not satisfy this schema
 * (fail fast), so misconfiguration surfaces at deploy time instead of at the first request.
 */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    SERVICE_NAME: z.string().min(1).default('location-tracking-service'),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    // `json` (one object per line) everywhere except optionally on a developer machine.
    LOG_FORMAT: z.enum(['json', 'pretty']).default('json'),

    // Required by the API role only; the role refuses to start without at least one key.
    API_KEYS: apiKeyList,

    HTTP_HOST: z.string().min(1).default('0.0.0.0'),
    // Optional: when unset each process role uses its own default (api 3000, worker 3001).
    HTTP_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    HTTP_BODY_LIMIT_BYTES: z.coerce.number().int().positive().default(1_048_576),
    HTTP_TRUST_PROXY: booleanString.default(false),
    // On SIGTERM: keep serving this long with readiness failing, so the load balancer stops routing here ...
    SHUTDOWN_DRAIN_DELAY_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),
    // ... and give up (exit 1) if the whole shutdown takes longer than this. Keep it below the
    // orchestrator's grace period (Kubernetes: terminationGracePeriodSeconds, 30 s by default).
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(600_000).default(25_000),

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

    // Upper bound on the positions of one area polygon (all rings together).
    AREA_MAX_VERTICES: z.coerce.number().int().min(4).max(100_000).default(5_000),

    KAFKA_BROKERS: commaSeparatedList
      .pipe(z.array(z.string().min(1)).min(1))
      .default(['localhost:9092']),
    // How long a produced message may wait for the broker's acknowledgement before the request fails with 503.
    KAFKA_DELIVERY_TIMEOUT_MS: z.coerce.number().int().min(100).max(300_000).default(3_000),
    // Messages buffered in the producer before new ones are rejected (backpressure → 503).
    KAFKA_PRODUCER_QUEUE_MAX_MESSAGES: z.coerce.number().int().positive().default(100_000),
    // Time the producer waits to fill a batch: a little latency for much higher throughput.
    KAFKA_LINGER_MS: z.coerce.number().int().min(0).max(1_000).default(5),
    // Used when provisioning topics; production clusters use 3.
    KAFKA_REPLICATION_FACTOR: z.coerce.number().int().min(1).max(5).default(1),
    // Circuit breaker of POST /locations: consecutive broker timeouts that open it, and how long it stays
    // open (answering 503 at once) before one trial request is let through.
    KAFKA_BREAKER_FAILURE_THRESHOLD: z.coerce.number().int().min(1).max(1_000).default(5),
    KAFKA_BREAKER_OPEN_MS: z.coerce.number().int().min(100).max(300_000).default(5_000),

    REDIS_URL: z.url({ protocol: /^rediss?$/ }).default('redis://localhost:6379'),
    // Redis is on the hot path; a slow Redis must not slow the API down (rate limiting fails open).
    REDIS_COMMAND_TIMEOUT_MS: z.coerce.number().int().min(10).max(10_000).default(100),

    // Accepted client timestamps: at most this far in the future (clock skew) ...
    PING_MAX_FUTURE_SKEW_MS: z.coerce.number().int().min(0).default(60_000),
    // ... and at most this old.
    PING_MAX_AGE_MS: z.coerce.number().int().positive().default(86_400_000),
    RATE_LIMIT_PINGS_PER_WINDOW: z.coerce.number().int().positive().default(10),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().min(100).default(10_000),

    // Worker: consumer group of the entry detector (work queue: the group shares the partitions).
    KAFKA_CONSUMER_GROUP: z.string().min(1).default('entry-detector'),
    // Partitions a worker instance processes in parallel; pings of one partition stay sequential.
    WORKER_PARTITION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(4),
    // Attempts for a ping that fails with a non-transient error before it goes to the dead letter topic.
    WORKER_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(3),
    // A gap between two pings longer than this ends the previous presence ("stale session", SPEC §3.8).
    PRESENCE_TTL_MS: z.coerce.number().int().positive().default(900_000),
    // How long the cached presence state of a user lives in Redis; must exceed PRESENCE_TTL_MS so the
    // last ping time is still known when a stale session has to be detected.
    PRESENCE_STATE_TTL_MS: z.coerce.number().int().positive().default(86_400_000),
    // Full reload of the in-memory area index, the safety net behind area.created events.
    AREA_INDEX_REFRESH_MS: z.coerce.number().int().min(1_000).default(60_000),

    // Outbox relay (worker): events published per transaction, and the pause when there is nothing to publish.
    OUTBOX_BATCH_SIZE: z.coerce.number().int().min(1).max(1_000).default(100),
    OUTBOX_POLL_INTERVAL_MS: z.coerce.number().int().min(10).max(60_000).default(500),
    // Broker rejections of one event before the relay stops retrying it (it stays for an operator).
    OUTBOX_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(100).default(10),

    // Housekeeping (worker): how often it runs, how long published outbox events and idempotency keys are kept.
    HOUSEKEEPING_INTERVAL_MS: z.coerce.number().int().min(1_000).default(600_000),
    OUTBOX_RETENTION_MS: z.coerce.number().int().min(60_000).default(604_800_000),
    IDEMPOTENCY_KEY_TTL_MS: z.coerce.number().int().min(60_000).default(86_400_000),
  })
  .refine((env) => env.PRESENCE_STATE_TTL_MS > env.PRESENCE_TTL_MS, {
    // Otherwise the last ping time expires together with the session and stale sessions go unnoticed.
    message: 'must be greater than PRESENCE_TTL_MS',
    path: ['PRESENCE_STATE_TTL_MS'],
  })
  .refine((env) => env.SHUTDOWN_DRAIN_DELAY_MS < env.SHUTDOWN_TIMEOUT_MS, {
    message: 'must be less than SHUTDOWN_TIMEOUT_MS',
    path: ['SHUTDOWN_DRAIN_DELAY_MS'],
  })
  .refine((env) => env.KAFKA_DELIVERY_TIMEOUT_MS < env.DB_IDLE_IN_TRANSACTION_TIMEOUT_MS, {
    // The outbox relay waits for the broker inside its transaction; the server would end the transaction
    // (and the relay's lock) before a slow acknowledgement arrived.
    message: 'must be less than DB_IDLE_IN_TRANSACTION_TIMEOUT_MS',
    path: ['KAFKA_DELIVERY_TIMEOUT_MS'],
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
