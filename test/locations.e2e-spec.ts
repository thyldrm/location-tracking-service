import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { validate as isUuid } from 'uuid';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import { MessageProducer } from '../src/core/messaging/message-producer.js';
import { Topics } from '../src/core/messaging/topics.js';
import { TEST_API_KEY, testEnv } from './support/test-env.js';
import { TopicRecorder } from './support/topic-recorder.js';

const authorized = { 'x-api-key': TEST_API_KEY };

/** Unique per test run, so the shared Redis counters and Kafka topic never mix runs. */
const runId = Date.now().toString(36);
const user = (name: string): string => `${name}-${runId}`;

function ping(userId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId,
    latitude: 40.995,
    longitude: 29.03,
    timestamp: new Date().toISOString(),
    accuracy: 8,
    ...overrides,
  };
}

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

/** An API application on the test infrastructure, with configuration overrides. */
async function startApp(overrides: Record<string, string> = {}): Promise<NestFastifyApplication> {
  const env = testEnv(overrides);
  const moduleRef = await Test.createTestingModule({
    imports: [ApiModule.forRoot(env)],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('POST /locations (e2e)', () => {
  let app: NestFastifyApplication;
  let recorder: TopicRecorder;

  const send = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): ReturnType<NestFastifyApplication['inject']> =>
    app.inject({
      method: 'POST',
      url: '/locations',
      headers: { ...authorized, ...headers },
      payload: body,
    });

  beforeAll(async () => {
    app = await startApp({ RATE_LIMIT_PINGS_PER_WINDOW: '3', RATE_LIMIT_WINDOW_MS: '60000' });

    const producer = app.get(MessageProducer);
    await waitUntil(() => producer.isConnected());
    recorder = await TopicRecorder.start(Topics.LocationPings);
  });

  afterAll(async () => {
    await recorder.stop();
    await app.close();
  });

  it('publishes the ping to Kafka, keyed by user, and answers 202', async () => {
    const userId = user('u-accept');
    const timestamp = '2026-10-08T15:00:00.000+03:00';
    const sentAt = new Date(timestamp);
    vi.setSystemTime(new Date(sentAt.getTime() + 2_000));
    let response: Awaited<ReturnType<typeof send>>;
    try {
      response = await send(ping(userId, { timestamp }), { 'x-request-id': 'ping-request-1' });
    } finally {
      vi.useRealTimers();
    }

    expect(response.statusCode).toBe(202);
    const body = response.json<{ pingId: string; status: string }>();
    expect(body.status).toBe('accepted');
    expect(isUuid(body.pingId)).toBe(true);

    const message = await recorder.waitFor(
      (recorded) => (recorded.value as { pingId?: string }).pingId === body.pingId,
    );
    expect(message.key).toBe(userId);
    expect(message.headers).toEqual({
      'x-request-id': 'ping-request-1',
      'content-type': 'application/json',
      'schema-version': '1',
    });
    expect(message.value).toEqual({
      pingId: body.pingId,
      userId,
      latitude: 40.995,
      longitude: 29.03,
      accuracy: 8,
      // Normalised to UTC.
      timestamp: '2026-10-08T12:00:00.000Z',
      receivedAt: '2026-10-08T12:00:02.000Z',
    });
  });

  it('sends every ping of a user to the same partition', async () => {
    const userId = user('u-ordered');
    const ids: string[] = [];
    for (let index = 0; index < 3; index++) {
      ids.push((await send(ping(userId))).json<{ pingId: string }>().pingId);
    }

    const messages = await Promise.all(
      ids.map((id) =>
        recorder.waitFor((recorded) => (recorded.value as { pingId?: string }).pingId === id),
      ),
    );
    expect(new Set(messages.map((message) => message.partition)).size).toBe(1);
  });

  it.each([
    ['a latitude out of range', { latitude: 91 }, 'latitude'],
    ['an invalid user id', { userId: 'user 42' }, 'userId'],
    ['a timestamp without offset', { timestamp: '2026-10-08T12:00:00' }, 'timestamp'],
    [
      'a timestamp far in the future',
      { timestamp: new Date(Date.now() + 120_000).toISOString() },
      'timestamp',
    ],
    [
      'a timestamp older than 24 h',
      { timestamp: new Date(Date.now() - 25 * 3_600_000).toISOString() },
      'timestamp',
    ],
    ['a negative accuracy', { accuracy: -1 }, 'accuracy'],
  ])('rejects %s', async (_label, overrides, path) => {
    const response = await send(ping(user('u-invalid'), overrides));

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ errors: [{ path }] });
  });

  it('limits pings per user and tells the client when to retry', async () => {
    const userId = user('u-limited');
    const statuses: number[] = [];
    let limited: Awaited<ReturnType<typeof send>> | undefined;
    for (let index = 0; index < 4; index++) {
      const response = await send(ping(userId));
      statuses.push(response.statusCode);
      if (response.statusCode === 429) limited = response;
    }

    expect(statuses).toEqual([202, 202, 202, 429]);
    expect(limited?.json()).toMatchObject({
      type: 'https://location-tracking-service/problems/rate-limited',
    });
    const retryAfter = Number(limited?.headers['retry-after']);
    expect(retryAfter).toBeGreaterThan(0);
    expect(retryAfter).toBeLessThanOrEqual(60);

    // The limit is per user: another user is unaffected.
    expect((await send(ping(user('u-other')))).statusCode).toBe(202);
  });

  it('requires an API key', async () => {
    const response = await app.inject({ method: 'POST', url: '/locations', payload: ping('u-1') });

    expect(response.statusCode).toBe(401);
  });
});

describe('POST /locations with unavailable dependencies (e2e)', () => {
  it('starts without Kafka, answers 503 quickly and keeps serving other endpoints', async () => {
    // Nothing listens on port 1: the broker is unreachable for the whole test.
    const app = await startApp({ KAFKA_BROKERS: '127.0.0.1:1' });
    try {
      const startedAt = Date.now();
      const response = await app.inject({
        method: 'POST',
        url: '/locations',
        headers: authorized,
        payload: ping(user('u-no-kafka')),
      });

      expect(Date.now() - startedAt).toBeLessThan(1_000);
      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('5');
      expect(response.json()).toMatchObject({
        type: 'https://location-tracking-service/problems/service-unavailable',
      });

      const areas = await app.inject({ method: 'GET', url: '/areas', headers: authorized });
      expect(areas.statusCode).toBe(200);
    } finally {
      const closingAt = Date.now();
      await app.close();
      // Shutdown aborts the pending connection attempt instead of waiting for it.
      expect(Date.now() - closingAt).toBeLessThan(5_000);
    }
  });

  it('keeps accepting pings when Redis is unreachable (rate limiting fails open)', async () => {
    const app = await startApp({
      REDIS_URL: 'redis://127.0.0.1:1',
      RATE_LIMIT_PINGS_PER_WINDOW: '1',
    });
    try {
      await waitUntil(() => app.get(MessageProducer).isConnected());
      const userId = user('u-no-redis');

      const statuses: number[] = [];
      for (let index = 0; index < 3; index++) {
        const response = await app.inject({
          method: 'POST',
          url: '/locations',
          headers: authorized,
          payload: ping(userId),
        });
        statuses.push(response.statusCode);
      }

      // With Redis, the second and third pings would have been limited (limit 1).
      expect(statuses).toEqual([202, 202, 202]);
    } finally {
      await app.close();
    }
  });
});
