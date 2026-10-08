import { createServer, type AddressInfo, connect, type Server, type Socket } from 'node:net';
import type { DynamicModule } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import type { Env } from '../src/core/config/env.schema.js';
import { MessageProducer } from '../src/core/messaging/message-producer.js';
import { WorkerModule } from '../src/worker.module.js';
import { TEST_API_KEY, testEnv } from './support/test-env.js';

const runId = Date.now().toString(36);
const headers = { 'x-api-key': TEST_API_KEY };

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

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/** A TCP proxy to PostgreSQL that is "down" (nothing listens on its port) until `open()`. */
class DatabaseProxy {
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  constructor(
    readonly port: number,
    private readonly target: { host: string; port: number },
  ) {}

  async open(): Promise<void> {
    this.server = createServer((client) => {
      const upstream = connect(this.target.port, this.target.host);
      for (const socket of [client, upstream]) {
        this.sockets.add(socket);
        socket.on('close', () => this.sockets.delete(socket));
        socket.on('error', () => socket.destroy());
      }
      client.pipe(upstream).pipe(client);
    });
    await new Promise<void>((resolve) => this.server?.listen(this.port, '127.0.0.1', resolve));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise((resolve) => (this.server ? this.server.close(resolve) : resolve(undefined)));
  }
}

async function readiness(app: NestFastifyApplication) {
  const response = await app.inject({ method: 'GET', url: '/health/ready' });
  return {
    status: response.statusCode,
    body: response.json<{ reasons: string[]; dependencies: { database: string } }>(),
  };
}

async function startApp(module: DynamicModule, env: Env): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({ imports: [module] }).compile();
  const app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}

/**
 * PostgreSQL is not needed to accept pings, so its absence must not keep a process from starting: a pod
 * rescheduled during a database outage would otherwise stop ingestion too (ADR 0012).
 */
describe('Starting while PostgreSQL is unreachable (e2e)', () => {
  let proxy: DatabaseProxy;
  let api: NestFastifyApplication;
  let worker: NestFastifyApplication;

  beforeAll(async () => {
    const real = testEnv();
    proxy = new DatabaseProxy(await freePort(), {
      host: real.POSTGRES_HOST,
      port: real.POSTGRES_PORT,
    });
    const env = testEnv({
      POSTGRES_HOST: '127.0.0.1',
      POSTGRES_PORT: String(proxy.port),
      KAFKA_CONSUMER_GROUP: `database-startup-e2e-${runId}`,
    });
    api = await startApp(ApiModule.forRoot(env), env);
    worker = await startApp(WorkerModule.forRoot(env), env);
  });

  afterAll(async () => {
    await worker.close();
    await api.close();
    await proxy.close();
  });

  it('starts and serves what does not need the database', async () => {
    expect((await api.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    expect(await readiness(api)).toMatchObject({
      status: 200,
      body: { dependencies: { database: 'down' } },
    });

    const areas = await api.inject({ method: 'GET', url: '/areas', headers });
    expect(areas.statusCode).toBe(503);
    expect(areas.headers['retry-after']).toBe('5');

    const producer = api.get(MessageProducer);
    await eventually(
      () => Promise.resolve(producer.isConnected()),
      (connected) => connected,
    );
    const ping = await api.inject({
      method: 'POST',
      url: '/locations',
      headers,
      payload: {
        userId: `database-startup-${runId}`,
        latitude: 40,
        longitude: 40,
        timestamp: new Date().toISOString(),
      },
    });
    expect(ping.statusCode).toBe(202);

    // The worker runs, but is not ready: its area index needs the database.
    expect(await readiness(worker)).toMatchObject({
      status: 503,
      body: { reasons: ['area-index'] },
    });
  });

  it('connects once PostgreSQL is reachable, without a restart', async () => {
    await proxy.open();

    await eventually(
      async () => (await api.inject({ method: 'GET', url: '/areas', headers })).statusCode,
      (status) => status === 200,
    );
    expect(await readiness(api)).toMatchObject({ body: { dependencies: { database: 'up' } } });
    await eventually(
      () => readiness(worker),
      (report) => report.status === 200,
    );
  });
});
