import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import { UuidV7Generator } from '../src/core/foundation/id-generator.js';
import { TEST_API_KEY, testEnv } from './support/test-env.js';

describe('GET /metrics (e2e)', () => {
  let app: NestFastifyApplication;

  const scrape = async (): Promise<string> =>
    (await app.inject({ method: 'GET', url: '/metrics' })).body;

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

  it('is served without an API key in the Prometheus text format', async () => {
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/plain');
    expect(response.body).toContain('# TYPE http_request_duration_seconds histogram');
    // Default process metrics, with the role of the process as a label.
    expect(response.body).toMatch(/nodejs_eventloop_lag_seconds\{role="api"\}/);
  });

  it('labels HTTP requests with the route template, never the raw path', async () => {
    const id = new UuidV7Generator().next();
    await app.inject({
      method: 'GET',
      url: `/areas/${id}`,
      headers: { 'x-api-key': TEST_API_KEY },
    });
    await app.inject({ method: 'GET', url: '/no-such-route' });

    const body = await scrape();

    expect(body).toMatch(
      /http_request_duration_seconds_count\{role="api",method="GET",route="\/areas\/:id",status_code="404"\} 1/,
    );
    expect(body).toMatch(/route="unmatched",status_code="404"/);
    expect(body).not.toContain(id);
    expect(body).not.toContain('no-such-route');
  });
});
