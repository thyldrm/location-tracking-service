import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Polygon } from 'geojson';
import { DataSource } from 'typeorm';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import { AreaEntity } from '../src/modules/areas/area.entity.js';
import { OutboxEventEntity } from '../src/modules/outbox/outbox-event.entity.js';
import { TEST_API_KEY, testEnv, truncateAllTables } from './support/test-env.js';

const authorized = { 'x-api-key': TEST_API_KEY };

/** Counterclockwise square around (29.03, 40.995), Kadikoy. */
const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [29.02, 40.99],
      [29.04, 40.99],
      [29.04, 41.0],
      [29.02, 41.0],
      [29.02, 40.99],
    ],
  ],
};

/** A "bow tie": the ring crosses itself at (29.03, 40.995). */
const bowTie: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [29.02, 40.99],
      [29.04, 41.0],
      [29.04, 40.99],
      [29.02, 41.0],
      [29.02, 40.99],
    ],
  ],
};

describe('Areas API (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;

  const createArea = (
    body: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): ReturnType<NestFastifyApplication['inject']> =>
    app.inject({
      method: 'POST',
      url: '/areas',
      headers: { ...authorized, ...headers },
      payload: body,
    });

  beforeAll(async () => {
    const env = testEnv({ AREA_MAX_VERTICES: '50' });
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(env)],
    }).compile();

    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    dataSource = app.get(DataSource);
  });

  beforeEach(async () => {
    await truncateAllTables(dataSource);
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /areas', () => {
    it('creates an area, returns it with a Location header and writes area.created to the outbox', async () => {
      const response = await createArea(
        { name: ' Kadikoy ', description: 'No parking', geometry: square },
        { 'x-request-id': 'create-area-1' },
      );

      expect(response.statusCode).toBe(201);
      const area = response.json<{ id: string; createdAt: string }>();
      expect(area).toEqual({
        id: expect.any(String),
        name: 'Kadikoy',
        description: 'No parking',
        geometry: square,
        createdAt: expect.any(String),
      });
      expect(response.headers.location).toBe(`/areas/${area.id}`);

      const events = await dataSource.getRepository(OutboxEventEntity).find();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        topic: 'area.lifecycle.v1',
        messageKey: area.id,
        eventType: 'area.created',
        publishedAt: null,
        headers: { 'x-request-id': 'create-area-1', 'schema-version': '1' },
        payload: {
          eventId: events[0]?.id,
          eventType: 'area.created',
          aggregateId: area.id,
          correlationId: 'create-area-1',
          payload: { areaId: area.id, name: 'Kadikoy', geometry: square },
        },
      });
    });

    it('stores the exterior ring counterclockwise whatever the client sent', async () => {
      const clockwise: Polygon = {
        type: 'Polygon',
        coordinates: [(square.coordinates[0] ?? []).toReversed()],
      };

      const created = await createArea({ name: 'Clockwise', geometry: clockwise });
      const fetched = await app.inject({
        method: 'GET',
        url: `/areas/${created.json<{ id: string }>().id}`,
        headers: authorized,
      });

      expect(fetched.json<{ geometry: Polygon }>().geometry).toEqual(square);
    });

    it('rejects a self-intersecting polygon with the PostGIS reason', async () => {
      const response = await createArea({ name: 'Bow tie', geometry: bowTie });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        type: 'https://location-tracking-service/problems/validation-error',
        errors: [{ path: 'geometry', message: expect.stringMatching(/^Self-intersection/) }],
      });
      expect(await dataSource.getRepository(AreaEntity).count()).toBe(0);
    });

    it('rejects a malformed body with every offending field', async () => {
      const response = await createArea({
        name: '',
        geometry: { type: 'Polygon', coordinates: [[[29, 41]]] },
      });

      expect(response.statusCode).toBe(400);
      const paths = response
        .json<{ errors: { path: string }[] }>()
        .errors.map((error) => error.path);
      expect(paths).toEqual(expect.arrayContaining(['name', 'geometry.coordinates.0']));
    });

    it('applies the configured vertex limit', async () => {
      const ring = Array.from({ length: 60 }, (_, index) => {
        const angle = (2 * Math.PI * index) / 60;
        return [29.03 + 0.01 * Math.cos(angle), 40.995 + 0.01 * Math.sin(angle)];
      });
      ring.push(ring[0] ?? []);

      const response = await createArea({
        name: 'Circle',
        geometry: { type: 'Polygon', coordinates: [ring] },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ errors: [{ path: 'geometry.coordinates' }] });
    });

    it('rejects a duplicate name regardless of case and writes no event', async () => {
      await createArea({ name: 'Kadikoy', geometry: square });

      const response = await createArea({ name: 'KADIKOY', geometry: square });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({
        type: 'https://location-tracking-service/problems/conflict',
        detail: 'An area named "KADIKOY" already exists.',
      });
      expect(await dataSource.getRepository(OutboxEventEntity).count()).toBe(1);
    });

    it('requires an API key', async () => {
      const response = await app.inject({ method: 'POST', url: '/areas', payload: {} });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Idempotency-Key', () => {
    it('replays the original response for a retried request', async () => {
      const body = { name: 'Moda', geometry: square };
      const first = await createArea(body, { 'idempotency-key': 'retry-1' });
      const retry = await createArea(body, { 'idempotency-key': 'retry-1' });

      expect(first.statusCode).toBe(201);
      expect(retry.statusCode).toBe(201);
      expect(retry.json()).toEqual(first.json());
      expect(retry.headers.location).toBe(first.headers.location);
      expect(retry.headers['idempotent-replayed']).toBe('true');
      expect(first.headers['idempotent-replayed']).toBeUndefined();
      expect(await dataSource.getRepository(AreaEntity).count()).toBe(1);
      expect(await dataSource.getRepository(OutboxEventEntity).count()).toBe(1);
    });

    it('creates exactly one area for concurrent requests with the same key', async () => {
      const body = { name: 'Concurrent', geometry: square };

      const responses = await Promise.all(
        Array.from({ length: 5 }, () => createArea(body, { 'idempotency-key': 'concurrent-1' })),
      );

      expect(responses.map((response) => response.statusCode)).toEqual([201, 201, 201, 201, 201]);
      expect(new Set(responses.map((response) => response.json<{ id: string }>().id)).size).toBe(1);
      expect(await dataSource.getRepository(AreaEntity).count()).toBe(1);
      expect(await dataSource.getRepository(OutboxEventEntity).count()).toBe(1);
    });

    it('rejects the same key with a different body', async () => {
      await createArea({ name: 'Moda', geometry: square }, { 'idempotency-key': 'retry-2' });

      const response = await createArea(
        { name: 'Fenerbahce', geometry: square },
        { 'idempotency-key': 'retry-2' },
      );

      expect(response.statusCode).toBe(422);
      expect(response.json()).toMatchObject({
        type: 'https://location-tracking-service/problems/unprocessable',
      });
    });

    it('does not keep a key whose request failed', async () => {
      await createArea({ name: 'Moda', geometry: square });

      const conflict = await createArea(
        { name: 'Moda', geometry: square },
        { 'idempotency-key': 'retry-3' },
      );
      await dataSource.createQueryBuilder().delete().from(AreaEntity).execute();
      const retry = await createArea(
        { name: 'Moda', geometry: square },
        { 'idempotency-key': 'retry-3' },
      );

      expect(conflict.statusCode).toBe(409);
      expect(retry.statusCode).toBe(201);
    });

    it('rejects an invalid key', async () => {
      const response = await createArea(
        { name: 'Moda', geometry: square },
        { 'idempotency-key': 'has spaces' },
      );

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({ errors: [{ path: 'idempotency-key' }] });
    });
  });

  describe('GET /areas', () => {
    it('pages through every area newest first without gaps or duplicates', async () => {
      for (let index = 0; index < 5; index++) {
        await createArea({ name: `Area ${index}`, geometry: square });
      }

      const names: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const query: string = cursor === null ? 'limit=2' : `limit=2&cursor=${cursor}`;
        const response = await app.inject({
          method: 'GET',
          url: `/areas?${query}`,
          headers: authorized,
        });
        expect(response.statusCode).toBe(200);
        const page = response.json<{
          data: { name: string }[];
          page: { nextCursor: string | null; limit: number };
        }>();
        names.push(...page.data.map((area) => area.name));
        cursor = page.page.nextCursor;
        pages++;
      } while (cursor !== null);

      expect(pages).toBe(3);
      expect(names).toEqual(['Area 4', 'Area 3', 'Area 2', 'Area 1', 'Area 0']);
    });

    it('returns an empty page when there are no areas', async () => {
      const response = await app.inject({ method: 'GET', url: '/areas', headers: authorized });

      expect(response.json()).toEqual({ data: [], page: { nextCursor: null, limit: 50 } });
    });

    it('rejects an invalid cursor or limit', async () => {
      const badCursor = await app.inject({
        method: 'GET',
        url: '/areas?cursor=forged',
        headers: authorized,
      });
      const badLimit = await app.inject({
        method: 'GET',
        url: '/areas?limit=1000',
        headers: authorized,
      });

      expect(badCursor.statusCode).toBe(400);
      expect(badCursor.json()).toMatchObject({ errors: [{ path: 'cursor' }] });
      expect(badLimit.statusCode).toBe(400);
      expect(badLimit.json()).toMatchObject({ errors: [{ path: 'limit' }] });
    });

    it('rejects an unknown query parameter instead of ignoring it', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/areas?limt=10',
        headers: authorized,
      });

      expect(response.statusCode).toBe(400);
      expect(response.json()).toMatchObject({
        errors: [{ path: 'limt', message: 'is not a recognised field' }],
      });
    });
  });

  describe('GET /areas/:id', () => {
    it('returns 404 for an unknown id and 400 for a malformed one', async () => {
      const unknown = await app.inject({
        method: 'GET',
        url: '/areas/0199b1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b',
        headers: authorized,
      });
      const malformed = await app.inject({
        method: 'GET',
        url: '/areas/not-a-uuid',
        headers: authorized,
      });

      expect(unknown.statusCode).toBe(404);
      expect(unknown.json()).toMatchObject({ type: expect.stringContaining('not-found') });
      expect(malformed.statusCode).toBe(400);
      expect(malformed.json()).toMatchObject({ errors: [{ path: 'id' }] });
    });
  });
});
