import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Polygon } from 'geojson';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import type { Env } from '../src/core/config/env.schema.js';
import { MessageProducer } from '../src/core/messaging/message-producer.js';
import { type ApiOperation, apiOperations } from '../src/modules/docs/api-operations.js';
import { buildOpenApiDocument } from '../src/modules/docs/openapi-document.js';
import { TEST_API_KEY, testEnv } from './support/test-env.js';

type Response = { statusCode: number; headers: Record<string, unknown>; body: string };
type Method = ApiOperation['method'];

const runId = Date.now().toString(36);
const headers = { 'x-api-key': TEST_API_KEY };

/** Away from the coordinates of the other test files. */
const GEOMETRY: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [34, 34],
      [35, 34],
      [35, 35],
      [34, 35],
      [34, 34],
    ],
  ],
};

async function waitUntil(condition: () => boolean, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('Condition not met in time');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function startApp(
  env: Env,
  onRoute?: (method: string, url: string) => void,
): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [ApiModule.forRoot(env)] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  if (onRoute) {
    app
      .getHttpAdapter()
      .getInstance()
      .addHook('onRoute', (route) => {
        for (const method of [route.method].flat()) onRoute(method, route.url);
      });
  }
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/**
 * The OpenAPI document is generated from the same table this test reads (`apiOperations`); the test
 * checks that table against the running application, so the documentation cannot drift from it.
 */
describe('OpenAPI document (e2e)', () => {
  const env = testEnv({ RATE_LIMIT_PINGS_PER_WINDOW: '1', RATE_LIMIT_WINDOW_MS: '60000' });
  const operations = apiOperations({ maxVertices: env.AREA_MAX_VERTICES });
  const document = buildOpenApiDocument(operations);
  const routes = new Set<string>();
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await startApp(env, (method, url) => routes.add(`${method} ${url}`));
    // The producer connects in the background; pings are answered 503 until then.
    const producer = app.get(MessageProducer);
    await waitUntil(() => producer.isConnected());
  });

  afterAll(async () => {
    await app.close();
  });

  /** Asserts that the response is one the document lists for the operation, body and headers included. */
  function expectDocumented(method: Method, path: string, response: Response): void {
    const operation = operations.find((item) => item.method === method && item.path === path);
    if (!operation) throw new Error(`${method.toUpperCase()} ${path} is not documented`);
    const documented = operation.responses[response.statusCode];
    if (!documented) {
      throw new Error(`${method.toUpperCase()} ${path} ${response.statusCode} is not documented`);
    }

    expect(String(response.headers['content-type'])).toContain(
      documented.contentType ?? 'application/json',
    );
    const body: unknown =
      documented.contentType === 'text/plain' ? response.body : JSON.parse(response.body);
    const parsed = documented.schema.safeParse(body);
    expect(parsed.error?.issues ?? [], `${method} ${path} ${response.statusCode}`).toEqual([]);

    const headerDefinitions = (
      document.components as { headers: Record<string, { required: boolean }> }
    ).headers;
    for (const name of ['x-request-id', ...(documented.headers ?? [])]) {
      if (headerDefinitions[name]?.required) {
        expect(response.headers[name], `${name} of ${method} ${path}`).toBeDefined();
      }
    }
  }

  const request = (method: Method, url: string, payload?: unknown, extra = {}): Promise<Response> =>
    app.inject({
      method: method === 'get' ? 'GET' : 'POST',
      url,
      headers: { ...headers, ...extra },
      ...(payload === undefined ? {} : { payload: payload as object }),
    });

  it('documents every route of the application, and only those', () => {
    const served = [...routes]
      .filter((route) => !route.startsWith('HEAD ') && !route.includes(' /docs'))
      .map((route) => route.toLowerCase().replace(/:(\w+)/g, '{$1}'))
      .toSorted();
    const listed = operations.map((item) => `${item.method} ${item.path}`).toSorted();

    expect(served).toEqual(listed);
  });

  it('serves the document and the Swagger UI without an API key', async () => {
    const page = await app.inject({ method: 'GET', url: '/docs' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('/docs/openapi.json');

    const served = await app.inject({ method: 'GET', url: '/docs/openapi.json' });
    expect(served.json()).toEqual(document);

    for (const asset of ['/docs/swagger-ui.css', '/docs/swagger-ui-bundle.js']) {
      const response = await app.inject({ method: 'GET', url: asset });
      expect(response.statusCode).toBe(200);
      expect(response.body.length).toBeGreaterThan(1_000);
    }
  });

  it('answers the area operations as documented', async () => {
    const body = { name: `OpenAPI ${runId}`, geometry: GEOMETRY };
    const key = { 'idempotency-key': `openapi-${runId}` };

    const created = await request('post', '/areas', body, key);
    expect(created.statusCode).toBe(201);
    expectDocumented('post', '/areas', created);
    const replayed = await request('post', '/areas', body, key);
    expect(replayed.headers['idempotent-replayed']).toBe('true');
    expectDocumented('post', '/areas', replayed);
    expectDocumented('post', '/areas', await request('post', '/areas', { name: '' }));
    expectDocumented(
      'post',
      '/areas',
      await request('post', '/areas', { ...body, name: body.name.toUpperCase() }),
    );
    expectDocumented(
      'post',
      '/areas',
      await request('post', '/areas', { ...body, description: 'other' }, key),
    );
    expectDocumented('post', '/areas', await app.inject({ method: 'POST', url: '/areas' }));

    const id = (JSON.parse(created.body) as { id: string }).id;
    expectDocumented('get', '/areas', await request('get', '/areas?limit=2'));
    expectDocumented('get', '/areas', await request('get', '/areas?limit=0'));
    expectDocumented('get', '/areas/{id}', await request('get', `/areas/${id}`));
    expectDocumented('get', '/areas/{id}', await request('get', '/areas/not-a-uuid'));
    expectDocumented(
      'get',
      '/areas/{id}',
      await request('get', '/areas/00000000-0000-7000-8000-000000000000'),
    );
  });

  it('answers pings and logs as documented', async () => {
    const ping = {
      userId: `openapi-${runId}`,
      latitude: 34.5,
      longitude: 34.5,
      timestamp: new Date().toISOString(),
    };
    const accepted = await request('post', '/locations', ping);
    expect(accepted.statusCode).toBe(202);
    expectDocumented('post', '/locations', accepted);
    const limited = await request('post', '/locations', ping);
    expect(limited.statusCode).toBe(429);
    expectDocumented('post', '/locations', limited);
    expectDocumented('post', '/locations', await request('post', '/locations', { userId: '' }));

    expectDocumented('get', '/logs', await request('get', `/logs?userId=${ping.userId}`));
    expectDocumented('get', '/logs', await request('get', '/logs?areaId=nope'));
  });

  it('answers the operational endpoints as documented', async () => {
    expectDocumented('get', '/health/live', await request('get', '/health/live'));
    expectDocumented('get', '/health/ready', await request('get', '/health/ready'));
    expectDocumented('get', '/metrics', await request('get', '/metrics'));
  });

  it('is not served when disabled (the default in production)', async () => {
    const disabled = await startApp(testEnv({ NODE_ENV: 'production' }));
    try {
      expect((await disabled.inject({ method: 'GET', url: '/docs' })).statusCode).toBe(404);
      expect((await disabled.inject({ method: 'GET', url: '/docs/openapi.json' })).statusCode).toBe(
        404,
      );
    } finally {
      await disabled.close();
    }
  });
});
