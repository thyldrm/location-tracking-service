import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import type { Env } from '../src/core/config/env.schema.js';
import { ProcessLifecycle } from '../src/core/lifecycle/process-lifecycle.js';
import type { ReadinessReport } from '../src/modules/health/readiness.service.js';
import { TEST_API_KEY, testEnv } from './support/test-env.js';

async function startApi(env: Env): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [ApiModule.forRoot(env)],
  }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

async function readiness(app: NestFastifyApplication) {
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  return { statusCode: response.statusCode, report: response.json<ReadinessReport>() };
}

describe('Health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await startApi(testEnv());
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });

  it('GET /health/ready is 200 and reports the dependencies', async () => {
    const { statusCode, report } = await readiness(app);

    expect(statusCode).toBe(200);
    expect(report).toMatchObject({
      status: 'ready',
      reasons: [],
      dependencies: { database: 'up', redis: 'up' },
    });
  });

  it('stays ready when shared dependencies are down, and says so', async () => {
    // Nothing listens on these ports: Kafka and Redis are unreachable for this instance.
    const isolated = await startApi(
      testEnv({ KAFKA_BROKERS: '127.0.0.1:1', REDIS_URL: 'redis://127.0.0.1:1' }),
    );
    try {
      const { statusCode, report } = await readiness(isolated);

      expect(statusCode).toBe(200);
      expect(report.dependencies).toEqual({ database: 'up', kafka: 'down', redis: 'down' });
    } finally {
      await isolated.close();
    }
  });

  it('fails readiness while draining, but keeps serving requests', async () => {
    app.get(ProcessLifecycle).startDraining();

    const { statusCode, report } = await readiness(app);
    const areas = await app.inject({
      method: 'GET',
      url: '/areas',
      headers: { 'x-api-key': TEST_API_KEY },
    });

    expect(statusCode).toBe(503);
    expect(report).toMatchObject({ status: 'not-ready', reasons: ['draining'] });
    expect(areas.statusCode).toBe(200);
  });
});
