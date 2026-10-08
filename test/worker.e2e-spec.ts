import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Polygon } from 'geojson';
import { Redis } from 'ioredis';
import type { DataSource } from 'typeorm';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import { UuidV7Generator } from '../src/core/foundation/id-generator.js';
import { createKafka } from '../src/core/messaging/kafka-client.js';
import { Topics } from '../src/core/messaging/topics.js';
import { AreaEntryEntity } from '../src/modules/area-entries/area-entry.entity.js';
import { AreaEntity } from '../src/modules/areas/area.entity.js';
import { OutboxEventEntity } from '../src/modules/outbox/outbox-event.entity.js';
import { WorkerModule } from '../src/worker.module.js';
import { createTestDataSource, testEnv, truncateAllTables } from './support/test-env.js';
import { TopicRecorder } from './support/topic-recorder.js';

const ids = new UuidV7Generator();
const runId = Date.now().toString(36);
const user = (name: string): string => `${name}-${runId}`;
const at = (minutes: number): string =>
  new Date(Date.UTC(2026, 9, 8, 12, 0) + minutes * 60_000).toISOString();

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Axis-aligned square; far away from the coordinates other test files use. */
function square(minX: number, minY: number, size: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minX, minY],
        [minX + size, minY],
        [minX + size, minY + size],
        [minX, minY + size],
        [minX, minY],
      ],
    ],
  };
}

/**
 * Value of one series in the Prometheus text format, matched by name and labels in any order (the
 * worker's role label is implied). NaN if the series is absent.
 */
function sample(body: string, name: string, labels: Record<string, string> = {}): number {
  const wanted = { role: 'worker', ...labels };
  for (const line of body.split('\n')) {
    const match = /^(\w+)\{(.*)\} (\S+)$/.exec(line);
    if (!match || match[1] !== name) continue;
    const present = Object.fromEntries(
      [...(match[2] ?? '').matchAll(/(\w+)="([^"]*)"/g)].map(([, key, value]) => [key, value]),
    );
    const same =
      Object.keys(present).length === Object.keys(wanted).length &&
      Object.entries(wanted).every(([key, value]) => present[key] === value);
    if (same) return Number(match[3]);
  }
  return Number.NaN;
}

const AREA_A = ids.next();
const AREA_B = ids.next();
const INSIDE_A = { longitude: 10.5, latitude: 10.5 };
const INSIDE_A_AND_B = { longitude: 10.9, latitude: 10.9 };
const ON_EDGE_OF_A = { longitude: 11, latitude: 10.2 };
const OUTSIDE = { longitude: 20, latitude: 20 };

async function eventually<T>(
  probe: () => Promise<T>,
  done: (value: T) => boolean,
  timeoutMs = 30_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`Timed out; last value: ${JSON.stringify(value)}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe('Worker: entry detection (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  let producer: KafkaJS.Producer;
  let redis: Redis;
  let deadLetters: TopicRecorder;
  let entryEvents: TopicRecorder;

  const send = async (
    userId: string,
    position: { longitude: number; latitude: number },
    timestamp: string,
    pingId = ids.next(),
  ): Promise<string> => {
    await producer.send({
      topic: Topics.LocationPings,
      messages: [
        {
          key: userId,
          value: JSON.stringify({
            pingId,
            userId,
            ...position,
            accuracy: 5,
            timestamp,
            receivedAt: timestamp,
          }),
          headers: {
            'x-request-id': `corr-${pingId}`,
            'content-type': 'application/json',
            'schema-version': '1',
          },
        },
      ],
    });
    return pingId;
  };

  const scrape = async (): Promise<string> =>
    (await app.inject({ method: 'GET', url: '/metrics' })).body;

  const entriesOf = (userId: string): Promise<AreaEntryEntity[]> =>
    dataSource.getRepository(AreaEntryEntity).find({
      where: { userId },
      order: { enteredAt: 'ASC', areaId: 'ASC' },
    });

  beforeAll(async () => {
    const env = testEnv({
      // A group of its own: reads the topic from the beginning, independently of other runs.
      KAFKA_CONSUMER_GROUP: `worker-e2e-${runId}`,
      PRESENCE_TTL_MS: String(15 * 60_000),
    });

    dataSource = await createTestDataSource();
    await truncateAllTables(dataSource);
    const now = new Date();
    await dataSource.getRepository(AreaEntity).insert([
      {
        id: AREA_A,
        name: 'A',
        description: null,
        geometry: square(10, 10, 1),
        createdAt: now,
        updatedAt: now,
      },
      {
        id: AREA_B,
        name: 'B',
        description: null,
        geometry: square(10.8, 10.8, 1),
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const moduleRef = await Test.createTestingModule({
      imports: [WorkerModule.forRoot(env)],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
    await app.init();

    producer = createKafka(env, quietLogger).producer({
      'enable.idempotence': true,
      'linger.ms': 0,
    });
    await producer.connect();
    redis = new Redis(env.REDIS_URL);
    deadLetters = await TopicRecorder.start(Topics.LocationPingsDeadLetter);
    entryEvents = await TopicRecorder.start(Topics.AreaEntries);
  });

  afterAll(async () => {
    await deadLetters.stop();
    await entryEvents.stop();
    await producer.disconnect();
    await redis.quit();
    await app.close();
    await dataSource.destroy();
  });

  it('is ready once its area index is loaded', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ready', reasons: [] });
  });

  it('records an entry with the client time of the first ping inside', async () => {
    const userId = user('enter');
    const pingId = await send(userId, INSIDE_A, at(0));

    const [entry] = await eventually(
      () => entriesOf(userId),
      (rows) => rows.length === 1,
    );

    expect(entry).toMatchObject({ areaId: AREA_A, enteredAt: new Date(at(0)), exitedAt: null });
    const event = await dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ messageKey: userId, eventType: 'area.entered' });
    // The correlation id of the ping follows it into the domain event.
    expect(event.headers['x-request-id']).toBe(`corr-${pingId}`);
    expect(event.payload).toMatchObject({ payload: { entryId: entry?.id, areaId: AREA_A } });

    // The outbox relay of the worker publishes the event to area.entries.v1.
    const published = await entryEvents.waitFor((message) => message.key === userId);
    expect(published.value).toEqual(event.payload);
    expect(published.headers['x-request-id']).toBe(`corr-${pingId}`);
  });

  it('records nothing while the user stays inside and closes the entry on the first ping outside', async () => {
    const userId = user('stay-exit');
    await send(userId, INSIDE_A, at(0));
    await send(userId, INSIDE_A, at(1));
    await send(userId, INSIDE_A, at(2));
    await send(userId, OUTSIDE, at(3));

    const entries = await eventually(
      () => entriesOf(userId),
      (rows) => rows[0]?.exitedAt !== null && rows.length > 0,
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ enteredAt: new Date(at(0)), exitedAt: new Date(at(3)) });
    const eventTypes = (
      await dataSource.getRepository(OutboxEventEntity).findBy({ messageKey: userId })
    ).map((event) => event.eventType);
    expect(eventTypes.toSorted()).toEqual(['area.entered', 'area.exited']);
  });

  it('records one entry per area for overlapping areas, and counts the boundary as inside', async () => {
    const both = user('overlap');
    const edge = user('edge');
    await send(both, INSIDE_A_AND_B, at(0));
    await send(edge, ON_EDGE_OF_A, at(0));

    const entries = await eventually(
      () => entriesOf(both),
      (rows) => rows.length === 2,
    );
    const edgeEntries = await eventually(
      () => entriesOf(edge),
      (rows) => rows.length === 1,
    );

    expect(entries.map((entry) => entry.areaId).toSorted()).toEqual([AREA_A, AREA_B].toSorted());
    expect(edgeEntries[0]?.areaId).toBe(AREA_A);
  });

  it('ignores a redelivered ping and a ping older than the processed ones', async () => {
    const userId = user('duplicates');
    const first = ids.next();
    await send(userId, INSIDE_A, at(0), first);
    await send(userId, INSIDE_A, at(0), first); // redelivery of the same message
    await send(userId, OUTSIDE, at(5));
    await send(userId, INSIDE_A, at(4)); // late: older than the exit, must not re-enter
    await send(userId, INSIDE_A, at(10)); // marker: a real new entry

    const entries = await eventually(
      () => entriesOf(userId),
      (rows) => rows.length === 2,
    );

    expect(entries).toMatchObject([
      { enteredAt: new Date(at(0)), exitedAt: new Date(at(5)) },
      { enteredAt: new Date(at(10)), exitedAt: null },
    ]);
  });

  it('starts a new entry after a stale session (gap longer than the presence TTL)', async () => {
    const userId = user('stale');
    await send(userId, INSIDE_A, at(0));
    await send(userId, INSIDE_A, at(20));

    const entries = await eventually(
      () => entriesOf(userId),
      (rows) => rows.length === 2,
    );

    expect(entries).toMatchObject([
      { enteredAt: new Date(at(0)), exitedAt: new Date(at(0)) },
      { enteredAt: new Date(at(20)), exitedAt: null },
    ]);
  });

  it('stays correct when the cached presence is lost (falls back to PostgreSQL)', async () => {
    const userId = user('cache-loss');
    await send(userId, INSIDE_A, at(0));
    await eventually(
      () => entriesOf(userId),
      (rows) => rows.length === 1,
    );

    await redis.del(`presence:${userId}`);
    await send(userId, INSIDE_A, at(1)); // still inside: must not create a second entry
    await send(userId, OUTSIDE, at(2));

    const entries = await eventually(
      () => entriesOf(userId),
      (rows) => rows[0]?.exitedAt !== null,
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.exitedAt).toEqual(new Date(at(2)));
  });

  it('sends an invalid message to the dead letter topic and keeps processing the partition', async () => {
    const userId = user('poison');
    await producer.send({
      topic: Topics.LocationPings,
      messages: [{ key: userId, value: '{"not":"a ping"}', headers: { 'schema-version': '1' } }],
    });
    await send(userId, INSIDE_A, at(0));

    const deadLetter = await deadLetters.waitFor((message) => message.key === userId);
    expect(deadLetter.headers).toMatchObject({
      'x-dlq-reason': 'invalid-message',
      'x-original-topic': Topics.LocationPings,
    });
    expect(deadLetter.value).toEqual({ not: 'a ping' });
    await eventually(
      () => entriesOf(userId),
      (rows) => rows.length === 1,
    );
  });

  it('reports processing, transitions, the relay and the area index in its metrics', async () => {
    // Earlier tests recorded entries; wait until the relay has published at least one of them.
    const body = await eventually(
      scrape,
      (text) => sample(text, 'outbox_events_published_total') > 0,
    );

    expect(
      sample(body, 'location_pings_processed_total', { outcome: 'transition' }),
    ).toBeGreaterThan(0);
    expect(sample(body, 'area_transitions_total', { type: 'entered' })).toBeGreaterThan(0);
    expect(
      sample(body, 'location_pings_dead_lettered_total', { reason: 'invalid-message' }),
    ).toBeGreaterThan(0);
    expect(sample(body, 'location_ping_processing_delay_seconds_count')).toBeGreaterThan(0);
    // At least the two areas of this file. The index also replays area.created events that earlier test
    // files left in the topic (their rows were truncated since), depending on when its consumer joins.
    expect(sample(body, 'area_index_areas')).toBeGreaterThanOrEqual(2);
    // Read from the table at scrape time.
    expect(sample(body, 'outbox_parked_events')).toBe(0);
    expect(sample(body, 'outbox_oldest_unpublished_age_seconds')).toBeGreaterThanOrEqual(0);
  });
});
