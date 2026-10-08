import { Injectable } from '@nestjs/common';
import { Redis, type Result } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Clock } from '../foundation/clock.js';
import { ThrottledLog } from '../logging/throttled-log.js';
import { Metrics } from '../metrics/metrics.js';
import { type RateLimitDecision, RateLimiter, type RateLimitPolicy } from './rate-limiter.js';

/** While Redis keeps failing, report it at most this often instead of on every request. */
const FAILURE_LOG_INTERVAL_MS = 60_000;

const KEY_PREFIX = 'rate-limit:';

/**
 * Runs atomically in Redis (no other command interleaves with a script):
 *   INCR key                    → events in the current window, including this one
 *   PEXPIRE key windowMs NX     → start the window's expiry only if it has none (the first event)
 *   PTTL key                    → time left in the window, returned as Retry-After
 */
const CONSUME_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
redis.call('PEXPIRE', KEYS[1], ARGV[1], 'NX')
return { count, redis.call('PTTL', KEYS[1]) }
`;

declare module 'ioredis' {
  interface RedisCommander<Context> {
    /** Defined by `RedisRateLimiter`: [events in the window, time left in ms]. */
    consumeRateLimit(key: string, windowMs: number): Result<unknown, Context>;
  }
}

/**
 * Fixed-window counter in Redis: the first event of a key starts a window of `windowMs`; every event
 * increments the counter; the key expires when the window ends.
 *
 * One command per event: a Lua script (sent as EVALSHA; ioredis falls back to EVAL when Redis does not
 * have it cached, e.g. after a restart). A MULTI/EXEC transaction would do the same in five commands,
 * each with its own reply and timeout timer on the client, at thousands of requests per second.
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
    private readonly metrics: Metrics,
  ) {
    super();
    this.redis.defineCommand('consumeRateLimit', { numberOfKeys: 1, lua: CONSUME_SCRIPT });
    this.failureLog = new ThrottledLog(FAILURE_LOG_INTERVAL_MS, () => clock.now().getTime());
  }

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    const redisKey = KEY_PREFIX + key;
    let reply: unknown;
    try {
      reply = await this.redis.consumeRateLimit(redisKey, policy.windowMs);
    } catch (error) {
      this.reportFailure(error);
      return { allowed: true };
    }

    if (!Array.isArray(reply) || typeof reply[0] !== 'number') {
      this.reportFailure(new Error('Unexpected reply to the rate limit script'));
      return { allowed: true };
    }
    const count = reply[0];
    const timeLeft: unknown = reply[1];
    if (count <= policy.limit) {
      return { allowed: true };
    }
    // PTTL is -1/-2 only if the key lost its expiry or vanished; fall back to a full window.
    const retryAfterMs = typeof timeLeft === 'number' && timeLeft > 0 ? timeLeft : policy.windowMs;
    return { allowed: false, retryAfterMs };
  }

  private reportFailure(error: unknown): void {
    // Counted every time, logged at most once a minute.
    this.metrics.rateLimiterFailOpen.inc();
    this.failureLog.record((suppressedSinceLastReport) =>
      this.logger.warn(
        { err: error, suppressedSinceLastReport },
        'Rate limiting unavailable; allowing requests (fail open)',
      ),
    );
  }
}
