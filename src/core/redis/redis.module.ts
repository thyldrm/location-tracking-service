import { Global, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema.js';

/**
 * Redis client options for a store that is useful but never required:
 * - commands fail fast instead of waiting while Redis is unreachable (`enableOfflineQueue: false`,
 *   no per-command retries, a short command timeout), so callers can degrade immediately;
 * - the client keeps reconnecting in the background with a capped back-off.
 */
function createRedis(config: ConfigService<Env, true>, logger: PinoLogger): Redis {
  logger.setContext('Redis');
  const redis = new Redis(config.get('REDIS_URL', { infer: true }), {
    connectionName: config.get('SERVICE_NAME', { infer: true }),
    commandTimeout: config.get('REDIS_COMMAND_TIMEOUT_MS', { infer: true }),
    enableOfflineQueue: false,
    maxRetriesPerRequest: 0,
    retryStrategy: (attempt) => Math.min(attempt * 200, 5_000),
  });
  // Without a listener, connection errors would be reported as unhandled 'error' events.
  let lastError: string | undefined;
  redis.on('error', (error: Error) => {
    // Log a failure once, not on every reconnect attempt.
    if (error.message !== lastError) {
      lastError = error.message;
      logger.warn({ err: error }, 'Redis connection error');
    }
  });
  redis.on('ready', () => {
    lastError = undefined;
    logger.info('Redis connected');
  });
  return redis;
}

@Injectable()
class RedisLifecycle implements OnApplicationShutdown {
  constructor(private readonly redis: Redis) {}

  async onApplicationShutdown(): Promise<void> {
    // QUIT waits for pending replies; disconnect() covers a client that is not connected.
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}

/** One Redis connection per process, injected by its class (`Redis` from ioredis). */
@Global()
@Module({
  providers: [
    {
      provide: Redis,
      inject: [ConfigService, PinoLogger],
      useFactory: createRedis,
    },
    RedisLifecycle,
  ],
  exports: [Redis],
})
export class RedisModule {}
