import type { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema.js';
import type { RequestContext } from '../../core/context/request-context.js';
import {
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from '../../core/errors/app-errors.js';
import {
  MessageProducer,
  type OutgoingMessage,
  PublishError,
} from '../../core/messaging/message-producer.js';
import type { Topic } from '../../core/messaging/topics.js';
import {
  type RateLimitDecision,
  RateLimiter,
  type RateLimitPolicy,
} from '../../core/rate-limit/rate-limiter.js';
import { LocationsService } from './locations.service.js';

const NOW = new Date('2026-10-08T12:00:00.000Z');
const PING_ID = '0199b1a2-0000-7000-8000-0000000000aa';

const settings: Partial<Env> = {
  PING_MAX_FUTURE_SKEW_MS: 60_000,
  PING_MAX_AGE_MS: 86_400_000,
  RATE_LIMIT_PINGS_PER_WINDOW: 10,
  RATE_LIMIT_WINDOW_MS: 10_000,
};
const config = { get: (key: keyof Env) => settings[key] } as ConfigService<Env, true>;

class RecordingProducer extends MessageProducer {
  readonly published: { topic: Topic; message: OutgoingMessage }[] = [];
  failure: PublishError | undefined;

  async publish(topic: Topic, message: OutgoingMessage): Promise<void> {
    if (this.failure) throw this.failure;
    this.published.push({ topic, message });
  }

  isConnected(): boolean {
    return true;
  }
}

class FixedRateLimiter extends RateLimiter {
  decision: RateLimitDecision = { allowed: true };
  readonly calls: { key: string; policy: RateLimitPolicy }[] = [];

  async consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision> {
    this.calls.push({ key, policy });
    return this.decision;
  }
}

function setup() {
  const producer = new RecordingProducer();
  const rateLimiter = new FixedRateLimiter();
  const service = new LocationsService(
    config,
    producer,
    rateLimiter,
    { next: () => PING_ID },
    { now: () => NOW },
    { correlationId: 'request-7' } as RequestContext,
  );
  return { service, producer, rateLimiter };
}

const ping = (timestamp: Date) => ({
  userId: 'u-42',
  latitude: 40.995,
  longitude: 29.03,
  timestamp,
});

describe('LocationsService', () => {
  it('publishes the ping keyed by user id with correlation headers', async () => {
    const { service, producer, rateLimiter } = setup();

    const result = await service.accept(ping(new Date('2026-10-08T11:59:58.000Z')));

    expect(result).toEqual({ pingId: PING_ID, status: 'accepted' });
    expect(rateLimiter.calls).toEqual([
      { key: 'pings:u-42', policy: { limit: 10, windowMs: 10_000 } },
    ]);
    expect(producer.published).toHaveLength(1);
    const [{ topic, message }] = producer.published as [{ topic: Topic; message: OutgoingMessage }];
    expect(topic).toBe('location.pings.v1');
    expect(message.key).toBe('u-42');
    expect(message.headers).toEqual({
      'x-request-id': 'request-7',
      'content-type': 'application/json',
      'schema-version': '1',
    });
    expect(JSON.parse(message.value)).toEqual({
      pingId: PING_ID,
      userId: 'u-42',
      latitude: 40.995,
      longitude: 29.03,
      accuracy: null,
      timestamp: '2026-10-08T11:59:58.000Z',
      receivedAt: NOW.toISOString(),
    });
  });

  it.each([
    ['exactly at the future limit', 60_000],
    ['exactly at the age limit', -86_400_000],
  ])('accepts a timestamp %s', async (_label, offsetMs) => {
    const { service } = setup();

    await expect(service.accept(ping(new Date(NOW.getTime() + offsetMs)))).resolves.toMatchObject({
      status: 'accepted',
    });
  });

  it.each([
    ['too far in the future', 60_001],
    ['too old', -86_400_001],
  ])('rejects a timestamp %s without consuming the rate limit', async (_label, offsetMs) => {
    const { service, rateLimiter } = setup();

    await expect(service.accept(ping(new Date(NOW.getTime() + offsetMs)))).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(rateLimiter.calls).toHaveLength(0);
  });

  it('rejects a limited user with Retry-After rounded up to whole seconds', async () => {
    const { service, producer, rateLimiter } = setup();
    rateLimiter.decision = { allowed: false, retryAfterMs: 2_100 };

    const error: unknown = await service.accept(ping(NOW)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(TooManyRequestsError);
    expect((error as TooManyRequestsError).headers).toEqual({ 'retry-after': '3' });
    expect(producer.published).toHaveLength(0);
  });

  it.each([
    ['queue-full', '1'],
    ['timeout', '5'],
    ['unavailable', '5'],
  ] as const)('maps a %s publish failure to a retryable 503', async (reason, retryAfter) => {
    const { service, producer } = setup();
    producer.failure = new PublishError(reason);

    const error: unknown = await service.accept(ping(NOW)).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect((error as ServiceUnavailableError).headers).toEqual({ 'retry-after': retryAfter });
    expect((error as ServiceUnavailableError).cause).toBe(producer.failure);
  });
});
