import { Body, Controller, Get, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { QueryFailedError } from 'typeorm';
import { validate as isUuid, version as uuidVersion } from 'uuid';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import { RequestContext } from '../src/core/context/request-context.js';
import { ConflictError } from '../src/core/errors/app-errors.js';
import { Public } from '../src/core/security/public.decorator.js';
import { flushLogs, LogCapture } from './support/log-capture.js';
import { TEST_API_KEY, testEnv } from './support/test-env.js';

/** Test-only routes that exercise the request pipeline. */
@Controller('probe')
class ProbeController {
  constructor(
    private readonly requestContext: RequestContext,
    @InjectPinoLogger('Probe') private readonly logger: PinoLogger,
  ) {}

  @Get('context')
  context(): { correlationId: string | undefined } {
    this.logger.info('handling probe request');
    return { correlationId: this.requestContext.correlationId };
  }

  @Post('echo')
  async echo(@Body() body: unknown): Promise<{ correlationId: string | undefined; body: unknown }> {
    // An await between body parsing and reading the context proves it survives asynchronous work.
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { correlationId: this.requestContext.correlationId, body };
  }

  @Get('conflict')
  conflict(): never {
    throw new ConflictError('An area named "Kadikoy" already exists.');
  }

  @Get('crash')
  crash(): never {
    throw new Error('connection string postgres://admin:secret@db-7 leaked');
  }

  @Get('database-timeout')
  databaseTimeout(): never {
    throw new QueryFailedError(
      'SELECT 1',
      [],
      Object.assign(new Error('timeout'), { code: '57014' }),
    );
  }

  @Public()
  @Get('public')
  open(): { ok: true } {
    return { ok: true };
  }
}

const authorized = { 'x-api-key': TEST_API_KEY };

describe('HTTP foundation (e2e)', () => {
  let app: NestFastifyApplication;
  const logs = new LogCapture();

  beforeAll(async () => {
    const env = testEnv({ LOG_LEVEL: 'debug', HTTP_BODY_LIMIT_BYTES: '1024' });
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(env, { logDestination: logs })],
      controllers: [ProbeController],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterEach(() => {
    logs.clear();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('correlation id', () => {
    it('generates a UUIDv7 correlation id and returns it in x-request-id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/context',
        headers: authorized,
      });

      const header = response.headers['x-request-id'];
      expect(typeof header).toBe('string');
      expect(isUuid(header)).toBe(true);
      expect(uuidVersion(header as string)).toBe(7);
      expect(response.json()).toEqual({ correlationId: header });
    });

    it('reuses a valid id sent by the caller (e.g. the API gateway)', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/context',
        headers: { ...authorized, 'x-request-id': 'gateway-trace-42' },
      });

      expect(response.headers['x-request-id']).toBe('gateway-trace-42');
      expect(response.json()).toEqual({ correlationId: 'gateway-trace-42' });
    });

    it('replaces an unsafe incoming id', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/context',
        headers: { ...authorized, 'x-request-id': 'x'.repeat(200) },
      });

      expect(response.headers['x-request-id']).not.toBe('x'.repeat(200));
      expect(isUuid(response.headers['x-request-id'])).toBe(true);
    });

    it('keeps the context through body parsing and asynchronous work', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/probe/echo',
        headers: { ...authorized, 'x-request-id': 'post-with-body-1' },
        payload: { hello: 'world' },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toEqual({
        correlationId: 'post-with-body-1',
        body: { hello: 'world' },
      });
    });

    it('stamps every log line of a request with its correlation id', async () => {
      await app.inject({
        method: 'GET',
        url: '/probe/context',
        headers: { ...authorized, 'x-request-id': 'log-check-1' },
      });
      await flushLogs();

      const messages = logs.withCorrelationId('log-check-1').map((line) => line.msg);
      expect(messages).toContain('handling probe request');
      expect(messages).toContain('GET /probe/context 200');
    });

    it('does not write access logs for health probes', async () => {
      await app.inject({
        method: 'GET',
        url: '/health/live',
        headers: { 'x-request-id': 'probe-noise-1' },
      });
      await flushLogs();

      expect(logs.withCorrelationId('probe-noise-1')).toEqual([]);
    });

    it('runs non-HTTP work (e.g. a consumed message) in its own correlated context', async () => {
      const requestContext = app.get(RequestContext);
      const logger = await app.resolve(PinoLogger);

      const seen = await requestContext.run('message-123', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        logger.info('processing message');
        return requestContext.correlationId;
      });

      expect(seen).toBe('message-123');
      expect(logs.withCorrelationId('message-123').map((line) => line.msg)).toContain(
        'processing message',
      );
      expect(requestContext.correlationId).toBeUndefined();
    });
  });

  describe('API key', () => {
    it('rejects a request without a key with a 401 problem', async () => {
      const response = await app.inject({ method: 'GET', url: '/probe/context' });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.headers['www-authenticate']).toBeDefined();
      expect(response.json()).toMatchObject({ status: 401, title: 'Unauthorized' });
    });

    it('rejects a wrong key', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/context',
        headers: { 'x-api-key': 'wrong-key-0123456789abcdef0123456789' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('lets public routes and health probes through without a key', async () => {
      expect((await app.inject({ method: 'GET', url: '/probe/public' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: '/health/live' })).statusCode).toBe(200);
    });

    it('never writes the key to the logs', async () => {
      await app.inject({ method: 'GET', url: '/probe/context', headers: authorized });
      await app.inject({ method: 'GET', url: '/probe/context' });
      await flushLogs();

      expect(JSON.stringify(logs.lines)).not.toContain(TEST_API_KEY);
    });
  });

  describe('error responses (RFC 9457)', () => {
    it('renders application errors as typed problems', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/conflict',
        headers: { ...authorized, 'x-request-id': 'conflict-1' },
      });

      expect(response.statusCode).toBe(409);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toEqual({
        type: 'https://location-tracking-service/problems/conflict',
        title: 'Conflict',
        status: 409,
        detail: 'An area named "Kadikoy" already exists.',
        instance: '/probe/conflict',
        correlationId: 'conflict-1',
      });
    });

    it('answers unknown routes with a 404 problem', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/does-not-exist',
        headers: authorized,
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ status: 404, instance: '/does-not-exist' });
    });

    it('hides unexpected errors from the client but logs them with the stack trace', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/crash',
        headers: { ...authorized, 'x-request-id': 'crash-1' },
      });
      await flushLogs();

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain('secret');
      expect(response.json()).toMatchObject({ status: 500, correlationId: 'crash-1' });

      const errorLog = logs
        .withCorrelationId('crash-1')
        .find((line) => line.msg === 'Request failed');
      expect(errorLog?.level).toBe('error');
      expect(JSON.stringify(errorLog?.err)).toContain('stack');
    });

    it('turns a database timeout into a retryable 503', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/probe/database-timeout',
        headers: authorized,
      });

      expect(response.statusCode).toBe(503);
      expect(response.headers['retry-after']).toBe('1');
    });

    it('rejects malformed JSON with a 400 problem', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/probe/echo',
        headers: { ...authorized, 'content-type': 'application/json' },
        payload: '{"broken": ',
      });

      expect(response.statusCode).toBe(400);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('rejects a body above the size limit with a 413 problem', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/probe/echo',
        headers: authorized,
        payload: { data: 'x'.repeat(2_000) },
      });

      expect(response.statusCode).toBe(413);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });
  });
});
