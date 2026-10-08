import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';
import type { PinoLogger } from 'nestjs-pino';
import { RedisRateLimiter } from '../../src/core/rate-limit/redis-rate-limiter.js';
import { testEnv } from '../support/test-env.js';

const silentLogger = { warn: vi.fn<(...args: unknown[]) => void>() } as unknown as PinoLogger;
const clock = { now: () => new Date() };

describe('RedisRateLimiter (integration)', () => {
  let redis: Redis;

  beforeAll(() => {
    redis = new Redis(testEnv().REDIS_URL);
  });

  afterAll(async () => {
    await redis.quit();
  });

  it('allows `limit` events per window, then reports the time left in the window', async () => {
    const limiter = new RedisRateLimiter(redis, clock, silentLogger);
    const key = `test:${randomUUID()}`;
    const policy = { limit: 3, windowMs: 2_000 };

    const decisions = [];
    for (let index = 0; index < 4; index++) {
      decisions.push(await limiter.consume(key, policy));
    }

    expect(decisions.slice(0, 3)).toEqual([
      { allowed: true },
      { allowed: true },
      { allowed: true },
    ]);
    const limited = decisions[3];
    expect(limited?.allowed).toBe(false);
    const retryAfterMs = limited && !limited.allowed ? limited.retryAfterMs : 0;
    expect(retryAfterMs).toBeGreaterThan(0);
    expect(retryAfterMs).toBeLessThanOrEqual(2_000);
  });

  it('starts a new window when the previous one expires', async () => {
    const limiter = new RedisRateLimiter(redis, clock, silentLogger);
    const key = `test:${randomUUID()}`;
    const policy = { limit: 1, windowMs: 300 };

    await limiter.consume(key, policy);
    expect((await limiter.consume(key, policy)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect((await limiter.consume(key, policy)).allowed).toBe(true);
  });

  it('keeps the window fixed: later events do not extend it', async () => {
    const limiter = new RedisRateLimiter(redis, clock, silentLogger);
    const key = `test:${randomUUID()}`;

    await limiter.consume(key, { limit: 100, windowMs: 1_000 });
    await new Promise((resolve) => setTimeout(resolve, 300));
    await limiter.consume(key, { limit: 100, windowMs: 1_000 });

    expect(await redis.pttl(`rate-limit:${key}`)).toBeLessThanOrEqual(700);
  });

  it('fails open when Redis is unreachable', async () => {
    const unreachable = new Redis('redis://127.0.0.1:1', {
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      lazyConnect: true,
    });
    unreachable.on('error', () => undefined);
    const limiter = new RedisRateLimiter(unreachable, clock, silentLogger);

    try {
      await expect(limiter.consume('anyone', { limit: 1, windowMs: 1_000 })).resolves.toEqual({
        allowed: true,
      });
      await expect(limiter.consume('anyone', { limit: 1, windowMs: 1_000 })).resolves.toEqual({
        allowed: true,
      });
    } finally {
      unreachable.disconnect();
    }
  });
});
