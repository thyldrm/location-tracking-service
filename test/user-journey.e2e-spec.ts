import type { DynamicModule } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Polygon } from 'geojson';
import type { DataSource } from 'typeorm';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import type { Env } from '../src/core/config/env.schema.js';
import type { AreaEntryResource } from '../src/modules/area-entries/area-entry.resource.js';
import { AreaIndexService } from '../src/modules/area-index/area-index.service.js';
import { WorkerModule } from '../src/worker.module.js';
import {
  createTestDataSource,
  TEST_API_KEY,
  testEnv,
  truncateAllTables,
} from './support/test-env.js';

type LogsPage = { data: AreaEntryResource[]; page: { nextCursor: string | null } };

const runId = Date.now().toString(36);
const headers = { 'x-api-key': TEST_API_KEY };

/** Away from the coordinates of the other test files. */
const AREA: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [32, 32],
      [33, 32],
      [33, 33],
      [32, 33],
      [32, 32],
    ],
  ],
};
const INSIDE = { latitude: 32.5, longitude: 32.5 };
const OUTSIDE = { latitude: 34, longitude: 34 };

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

/**
 * The whole service as a client uses it, through HTTP only: an area is created, pings are sent, and the
 * entry shows up in the logs. Every hop in between is real: the outbox relay, Kafka, the worker's area
 * index and entry detection, PostgreSQL.
 */
describe('User journey through the public API (e2e)', () => {
  let api: NestFastifyApplication;
  let worker: NestFastifyApplication;
  let dataSource: DataSource;

  beforeAll(async () => {
    const env = testEnv({
      KAFKA_CONSUMER_GROUP: `user-journey-e2e-${runId}`,
      OUTBOX_POLL_INTERVAL_MS: '100',
    });
    dataSource = await createTestDataSource();
    await truncateAllTables(dataSource);

    api = await startApp(ApiModule.forRoot(env), env);
    worker = await startApp(WorkerModule.forRoot(env), env);
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
    await dataSource.destroy();
  });

  async function sendPing(userId: string, position: typeof INSIDE, timestamp: Date): Promise<void> {
    const response = await api.inject({
      method: 'POST',
      url: '/locations',
      headers,
      payload: { userId, ...position, timestamp: timestamp.toISOString() },
    });
    expect(response.statusCode).toBe(202);
  }

  async function logsOf(userId: string): Promise<AreaEntryResource[]> {
    const response = await api.inject({ method: 'GET', url: `/logs?userId=${userId}`, headers });
    expect(response.statusCode).toBe(200);
    return response.json<LogsPage>().data;
  }

  it('records the entry and the exit of a user crossing an area', async () => {
    const created = await api.inject({
      method: 'POST',
      url: '/areas',
      headers,
      payload: { name: `Journey ${runId}`, geometry: AREA },
    });
    expect(created.statusCode).toBe(201);
    const areaId = created.json<{ id: string }>().id;

    // The area reaches the worker asynchronously (outbox -> Kafka -> area index); a client would not
    // notice, but pings processed before that would rightly not count as inside.
    const areaIndex = worker.get(AreaIndexService);
    await eventually(
      () => Promise.resolve(areaIndex.areasContaining(INSIDE.longitude, INSIDE.latitude)),
      (areas) => areas.includes(areaId),
    );

    const userId = `journey-${runId}`;
    const start = Date.now() - 60_000;
    const at = (second: number): Date => new Date(start + second * 1_000);
    await sendPing(userId, OUTSIDE, at(0));
    await sendPing(userId, INSIDE, at(10));
    await sendPing(userId, INSIDE, at(20));

    const entered = await eventually(
      () => logsOf(userId),
      (entries) => entries.length > 0,
    );
    expect(entered).toEqual([
      expect.objectContaining({
        userId,
        areaId,
        enteredAt: at(10).toISOString(),
        exitedAt: null,
      }),
    ]);

    await sendPing(userId, OUTSIDE, at(30));

    const exited = await eventually(
      () => logsOf(userId),
      (entries) => entries[0]?.exitedAt !== null,
    );
    expect(exited).toEqual([
      expect.objectContaining({
        id: entered[0]?.id,
        enteredAt: at(10).toISOString(),
        exitedAt: at(30).toISOString(),
      }),
    ]);
  });
});
