import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { DynamicModule } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Polygon } from 'geojson';
import type { DataSource } from 'typeorm';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import type { Env } from '../src/core/config/env.schema.js';
import { UuidV7Generator } from '../src/core/foundation/id-generator.js';
import { createKafka } from '../src/core/messaging/kafka-client.js';
import { Topics } from '../src/core/messaging/topics.js';
import { AreaEntryEntity } from '../src/modules/area-entries/area-entry.entity.js';
import { AreaIndexService } from '../src/modules/area-index/area-index.service.js';
import { OutboxEventEntity } from '../src/modules/outbox/outbox-event.entity.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  createTestDataSource,
  TEST_API_KEY,
  testEnv,
  truncateAllTables,
} from './support/test-env.js';
import { TopicRecorder } from './support/topic-recorder.js';

const ids = new UuidV7Generator();
const runId = Date.now().toString(36);
const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/** Away from the coordinates of the other test files. */
const AREA: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [30, 30],
      [31, 30],
      [31, 31],
      [30, 31],
      [30, 30],
    ],
  ],
};

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

async function startApp(module: DynamicModule, env: Env): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

describe('A new area reaches the worker through area.created (e2e)', () => {
  let api: NestFastifyApplication;
  let worker: NestFastifyApplication;
  let dataSource: DataSource;
  let producer: KafkaJS.Producer;
  let entryEvents: TopicRecorder;

  beforeAll(async () => {
    const env = testEnv({
      KAFKA_CONSUMER_GROUP: `area-lifecycle-e2e-${runId}`,
      // Far beyond the test's duration: only the event can explain a detected entry.
      AREA_INDEX_REFRESH_MS: String(10 * 60_000),
      OUTBOX_POLL_INTERVAL_MS: '100',
    });
    dataSource = await createTestDataSource();
    await truncateAllTables(dataSource);

    api = await startApp(ApiModule.forRoot(env), env);
    worker = await startApp(WorkerModule.forRoot(env), env);
    const areaIndex = worker.get(AreaIndexService);
    await eventually(
      () => Promise.resolve(areaIndex.isReady()),
      (ready) => ready,
    );

    producer = createKafka(env, quietLogger).producer({ 'linger.ms': 0 });
    await producer.connect();
    entryEvents = await TopicRecorder.start(Topics.AreaEntries);
  });

  afterAll(async () => {
    await entryEvents.stop();
    await producer.disconnect();
    await worker.close();
    await api.close();
    await dataSource.destroy();
  });

  it('detects entries into an area created through the API without waiting for a reload', async () => {
    const response = await api.inject({
      method: 'POST',
      url: '/areas',
      headers: { 'x-api-key': TEST_API_KEY },
      payload: { name: `Lifecycle ${runId}`, geometry: AREA },
    });
    expect(response.statusCode).toBe(201);
    const areaId = response.json<{ id: string }>().id;

    // Pings inside the area, one per second of client time, until the worker knows the area.
    const userId = `lifecycle-${runId}`;
    const start = Date.UTC(2026, 9, 8, 12, 0);
    let second = 0;
    const entries = await eventually(
      async () => {
        const timestamp = new Date(start + second++ * 1_000).toISOString();
        await producer.send({
          topic: Topics.LocationPings,
          messages: [
            {
              key: userId,
              value: JSON.stringify({
                pingId: ids.next(),
                userId,
                latitude: 30.5,
                longitude: 30.5,
                accuracy: 5,
                timestamp,
                receivedAt: timestamp,
              }),
              headers: { 'content-type': 'application/json', 'schema-version': '1' },
            },
          ],
        });
        return dataSource.getRepository(AreaEntryEntity).findBy({ userId });
      },
      (rows) => rows.length > 0,
    );

    expect(entries).toMatchObject([{ areaId, exitedAt: null }]);
    const areaCreated = await dataSource
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ eventType: 'area.created', messageKey: areaId });
    expect(areaCreated.publishedAt).toBeInstanceOf(Date);
    const published = await entryEvents.waitFor((message) => message.key === userId);
    expect(published.value).toMatchObject({ eventType: 'area.entered', payload: { areaId } });
  });
});
