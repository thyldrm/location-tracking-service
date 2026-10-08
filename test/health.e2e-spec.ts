import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import { testEnv } from './support/test-env.js';

describe('Health (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    const env = testEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(env)],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('GET /health/live returns 200', async () => {
    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
  });
});
