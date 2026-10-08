import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test } from '@nestjs/testing';
import type { Polygon } from 'geojson';
import { DataSource } from 'typeorm';
import { ApiModule } from '../src/api.module.js';
import { createFastifyAdapter } from '../src/bootstrap/create-fastify-adapter.js';
import { UuidV7Generator } from '../src/core/foundation/id-generator.js';
import { AreaEntryEntity } from '../src/modules/area-entries/area-entry.entity.js';
import type { AreaEntryResource } from '../src/modules/area-entries/area-entry.resource.js';
import { AreaEntity } from '../src/modules/areas/area.entity.js';
import { TEST_API_KEY, testEnv, truncateAllTables } from './support/test-env.js';

const authorized = { 'x-api-key': TEST_API_KEY };
const ids = new UuidV7Generator();
const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 8, 12, 0) + minutes * 60_000);

const square: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 1],
      [0, 0],
    ],
  ],
};

type LogsPage = { data: AreaEntryResource[]; page: { nextCursor: string | null; limit: number } };

const idsOf = (page: LogsPage): string[] => page.data.map((item) => item.id);

function entry(userId: string, areaId: string, entered: number, exited: number | null) {
  return {
    id: ids.next(),
    userId,
    areaId,
    enteredAt: at(entered),
    exitedAt: exited === null ? null : at(exited),
  };
}

describe('GET /logs (e2e)', () => {
  let app: NestFastifyApplication;
  let dataSource: DataSource;
  const AREA_A = ids.next();
  const AREA_B = ids.next();
  /** Entries in the order GET /logs must return them: newest enteredAt first, ties by id descending. */
  let expected: AreaEntryEntity[];

  const pick = (keep: (row: AreaEntryEntity) => boolean): string[] =>
    expected.filter(keep).map((row) => row.id);

  const get = async (query: string, headers = authorized) =>
    app.inject({ method: 'GET', url: `/logs${query}`, headers });

  beforeAll(async () => {
    const env = testEnv();
    const moduleRef = await Test.createTestingModule({
      imports: [ApiModule.forRoot(env)],
    }).compile();
    app = moduleRef.createNestApplication<NestFastifyApplication>(createFastifyAdapter(env));
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    dataSource = app.get(DataSource);

    await truncateAllTables(dataSource);
    const now = new Date();
    await dataSource.getRepository(AreaEntity).insert(
      [AREA_A, AREA_B].map((id, index) => ({
        id,
        name: `Logs ${index}`,
        description: null,
        geometry: square,
        createdAt: now,
        updatedAt: now,
      })),
    );
    const rows = [
      entry('u-1', AREA_A, 0, 5),
      entry('u-1', AREA_B, 10, 20),
      // Three entries at the same instant: the page boundary will fall between them.
      entry('u-2', AREA_A, 10, null),
      entry('u-3', AREA_A, 10, 11),
      entry('u-1', AREA_A, 30, null),
    ];
    await dataSource.getRepository(AreaEntryEntity).insert(rows);
    expected = await dataSource
      .getRepository(AreaEntryEntity)
      .find({ order: { enteredAt: 'DESC', id: 'DESC' } });
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists entries newest first with every field', async () => {
    const response = await get('');
    const first = expected[0];

    expect(response.statusCode).toBe(200);
    const body = response.json<LogsPage>();
    expect(idsOf(body)).toEqual(expected.map((row) => row.id));
    expect(body.page).toEqual({ nextCursor: null, limit: 50 });
    expect(body.data[0]).toEqual({
      id: first?.id,
      userId: 'u-1',
      areaId: AREA_A,
      enteredAt: at(30).toISOString(),
      exitedAt: null,
      createdAt: first?.createdAt.toISOString(),
    });
  });

  it('filters by user, by area, by both and by a time range (from inclusive, to exclusive)', async () => {
    const byUser = (await get('?userId=u-1')).json<LogsPage>();
    const byArea = (await get(`?areaId=${AREA_B}`)).json<LogsPage>();
    const byBoth = (await get(`?userId=u-1&areaId=${AREA_A}`)).json<LogsPage>();
    const byRange = (
      await get(`?from=${at(10).toISOString()}&to=${at(30).toISOString()}`)
    ).json<LogsPage>();

    expect(idsOf(byUser)).toEqual(pick((row) => row.userId === 'u-1'));
    expect(idsOf(byArea)).toEqual(pick((row) => row.areaId === AREA_B));
    expect(idsOf(byBoth)).toEqual(pick((row) => row.userId === 'u-1' && row.areaId === AREA_A));
    expect(idsOf(byRange)).toEqual(
      pick((row) => row.enteredAt >= at(10) && row.enteredAt < at(30)),
    );
    expect(byRange.data).toHaveLength(3);
  });

  it('accepts an offset other than Z when "+" is encoded', async () => {
    // 15:10 at +03:00 is 12:10Z: the three entries at minute 10 and the one at 30.
    const response = await get('?from=2026-10-08T15:10:00%2B03:00');

    expect(response.statusCode).toBe(200);
    expect(response.json<LogsPage>().data).toHaveLength(4);
  });

  it('pages through entries with equal enteredAt without gaps or duplicates', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const query: string = cursor === null ? '?limit=2' : `?limit=2&cursor=${cursor}`;
      const page: LogsPage = (await get(query)).json<LogsPage>();
      seen.push(...idsOf(page));
      cursor = page.page.nextCursor;
    } while (cursor !== null);

    expect(seen).toEqual(expected.map((row) => row.id));
  });

  it('rejects a cursor replayed with other filters', async () => {
    const first = (await get('?userId=u-1&limit=1')).json<LogsPage>();

    const response = await get(`?userId=u-2&limit=1&cursor=${first.page.nextCursor ?? ''}`);

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      errors: [{ path: 'cursor', message: expect.stringContaining('other filters') }],
    });
  });

  it('rejects invalid queries with every offending field', async () => {
    const response = await get(
      `?userId=u%2042&areaId=nope&from=2026-10-08T10:00:00&limit=0&userID=x&cursor=forged`,
    );

    expect(response.statusCode).toBe(400);
    expect(
      response
        .json<{ errors: Array<{ path: string }> }>()
        .errors.map((error) => error.path)
        .toSorted(),
    ).toEqual(['areaId', 'from', 'limit', 'userID', 'userId']);

    const backwards = await get(`?from=${at(10).toISOString()}&to=${at(5).toISOString()}`);
    expect(backwards.json()).toMatchObject({ errors: [{ path: 'to' }] });
    const forged = await get('?cursor=forged');
    expect(forged.json()).toMatchObject({ errors: [{ path: 'cursor' }] });
  });

  it('returns an empty page for filters that match nothing, including an unknown area', async () => {
    const response = await get(`?areaId=${ids.next()}`);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ data: [], page: { nextCursor: null, limit: 50 } });
  });

  it('requires an API key', async () => {
    const response = await get('', { 'x-api-key': '' });

    expect(response.statusCode).toBe(401);
  });
});
