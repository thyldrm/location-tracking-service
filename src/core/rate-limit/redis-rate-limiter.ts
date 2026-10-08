import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Clock } from '../foundation/clock.js';
import { ThrottledLog } from '../logging/throttled-log.js';
import { type RateLimitDecision, RateLimiter, type RateLimitPolicy } from './rate-limiter.js';

/** While Redis keeps failing, report it at most this often instead of on every request. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

const KEY_PREFIX = 'rate-limit:';

/**
 * Fixed-window counter in Redis: the first event of a key starts a window of `windowMs`; every event
 * increments the counter; the key expires when the window ends.
 *
 * One round trip, atomically (MULTI/EXEC):
 *   INCR key                    → events in the current window, including this one
 *   PEXPIRE key windowMs NX     → start the window's expiry only if it has none (the first event)
 *   PTTL key                    → time left in the window, returned as Retry-After
 *
 * The counter is shared by every API instance, so the limit holds however many instances there are.
 *
 * **Fails open:** if Redis is slow or unreachable the event is allowed. Rate limiting protects the system
 * from misbehaving clients; it must not turn a Redis outage into an outage of location ingestion.
 */
@Injectable()
export class RedisRateLimiter extends RateLimiter {
  private readonly failureLog: ThrottledLog;

  constructor(
    private readonly redis: Redis,
    clock: Clock,
    @InjectPinoLogger(RedisRateLimiter.name) private readonly logger: PinoLogger,
  ) {
    super();
    this.failureLog = new ThrottledLog(FAILURE_LOG_INTERVAL_MS, () => clock.now().getTime());
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const redisKey = KEY_PREFIX + key;
    let replies: [error: Error | null, result: unknown][] | null;
    try {
      replies = await this.redis
        .multi()
        .incr(redisKey)
        .pexpire(redisKey, policy.windowMs, 'NX')
        .pttl(redisKey)
        .exec();
    } catch (error) {
      this.reportFailure(error);
      return { allowed: true };
    }

    const [count, , timeLeft] = (replies ?? []).map(([error, result]) =>
      error === null && typeof result === 'number' ? result : undefined,
    );
    if (count === undefined) {
      this.reportFailure(new Error('Unexpected reply to the rate limit transaction'));
      return { allowed: true };
    }
    if (count <= policy.limit) {
      return { allowed: true };
    }
    // PTTL is -1/-2 only if the key lost its expiry or vanished; fall back to a full window.
    const retryAfterMs = timeLeft !== undefined && timeLeft > 0 ? timeLeft : policy.windowMs;
    return { allowed: false, retryAfterMs };
  }

  private reportFailure(error: unknown): void {
    this.failureLog.record((suppressedSinceLastReport) =>
      this.logger.warn(
        { err: error, suppressedSinceLastReport },
        'Rate limiting unavailable; allowing requests (fail open)',
      ),
    );
  }
}
