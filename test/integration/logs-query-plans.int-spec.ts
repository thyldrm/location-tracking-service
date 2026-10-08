import type { DataSource } from 'typeorm';
import { UuidV7Generator } from '../../src/core/foundation/id-generator.js';
import { AreaEntriesService } from '../../src/modules/area-entries/area-entries.service.js';
import { AreaEntryEntity } from '../../src/modules/area-entries/area-entry.entity.js';
import type { LogFilters } from '../../src/modules/area-entries/area-entry.schemas.js';
import { AreaEntity } from '../../src/modules/areas/area.entity.js';
import { createTestDataSource, truncateAllTables } from '../support/test-env.js';

const ids = new UuidV7Generator();
const AREAS = Array.from({ length: 5 }, () => ids.next());
const [AREA] = AREAS;
const ENTRIES = 60_000;
/** Every sixth entry belongs to one very active user. */
const HEAVY_USER = 'u-heavy';
const CURSOR = { enteredAt: new Date('2026-10-04T00:00:00Z'), id: ids.next() };

type PlanNode = {
  'Node Type': string;
  'Index Name'?: string;
  'Index Cond'?: string;
  Plans?: PlanNode[];
};

function nodesOf(node: PlanNode): PlanNode[] {
  return [node, ...(node.Plans ?? []).flatMap(nodesOf)];
}

const types = (nodes: PlanNode[]): string[] => nodes.map((node) => node['Node Type']);
const indexes = (nodes: PlanNode[]): Array<string | undefined> =>
  nodes.map((node) => node['Index Name']).filter((name) => name !== undefined);

/**
 * GET /logs must stay fast however large `area_entries` grows. With realistic statistics (60,000 rows,
 * analysed) every access path must use one of the three indexes ending in `(entered_at DESC, id DESC)`,
 * never a sequential scan. When many rows match, the index must deliver them already sorted: no Sort
 * node, so PostgreSQL reads `limit + 1` entries and stops. For a handful of matching rows the planner may
 * fetch them and sort them, which is cheaper and fine.
 */
describe('GET /logs query plans (integration)', () => {
  let dataSource: DataSource;
  let service: AreaEntriesService;

  const planOf = async (
    filters: LogFilters,
    after?: { enteredAt: Date; id: string },
  ): Promise<PlanNode[]> => {
    const [sql, parameters] = service
      .pageQuery({ ...filters, limit: 50 }, after)
      .getQueryAndParameters();
    const [row] = (await dataSource.query(`EXPLAIN (FORMAT JSON) ${sql}`, parameters)) as Array<{
      'QUERY PLAN': Array<{ Plan: PlanNode }>;
    }>;
    const plan = row?.['QUERY PLAN'][0]?.Plan;
    if (!plan) throw new Error('No plan returned');
    return nodesOf(plan);
  };

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    service = new AreaEntriesService(dataSource.getRepository(AreaEntryEntity));
    await truncateAllTables(dataSource);
    const now = new Date();
    await dataSource.getRepository(AreaEntity).insert(
      AREAS.map((id, index) => ({
        id,
        name: `Plan ${index}`,
        description: null,
        geometry: {
          type: 'Polygon' as const,
          coordinates: [
            [
              [0, 0],
              [1, 0],
              [1, 1],
              [0, 0],
            ],
          ],
        },
        createdAt: now,
        updatedAt: now,
      })),
    );
    // Raw SQL: generating rows in the database is much faster than inserting 60,000 entities.
    await dataSource.query(
      `INSERT INTO area_entries (id, user_id, area_id, entered_at)
       SELECT gen_random_uuid(),
              CASE WHEN g % 6 = 0 THEN $3 ELSE 'u-' || (g % 1000) END,
              ($1::uuid[])[1 + g % 5],
              timestamptz '2026-10-01T00:00:00Z' + g * interval '10 seconds'
       FROM generate_series(1, $2::int) AS g`,
      [AREAS, ENTRIES, HEAVY_USER],
    );
    await dataSource.query('ANALYZE area_entries');
  });

  afterAll(async () => {
    await truncateAllTables(dataSource);
    await dataSource.destroy();
  });

  it.each<[string, LogFilters, string]>([
    ['no filter', {}, 'idx_area_entries_entered'],
    ['an active user', { userId: HEAVY_USER }, 'idx_area_entries_user_entered'],
    ['an area', { areaId: AREA }, 'idx_area_entries_area_entered'],
    [
      'a time range',
      { from: new Date('2026-10-02T00:00:00Z'), to: new Date('2026-10-03T00:00:00Z') },
      'idx_area_entries_entered',
    ],
  ])('reads %s in index order and stops at the limit', async (_name, filters, index) => {
    const nodes = await planOf(filters);

    expect(types(nodes)).toEqual(['Limit', 'Index Scan']);
    expect(indexes(nodes)).toEqual([index]);
  });

  it('applies the cursor inside the index condition, not as a filter on fetched rows', async () => {
    const nodes = await planOf({ userId: HEAVY_USER }, CURSOR);

    expect(types(nodes)).toEqual(['Limit', 'Index Scan']);
    expect(nodes[1]?.['Index Cond']).toMatch(/ROW\(entered_at, id\) < ROW\(/);
  });

  it('never scans the whole table, whatever the combination of filters', async () => {
    const combinations: Array<[LogFilters, typeof CURSOR | undefined]> = [
      [{ userId: 'u-7' }, undefined],
      [{ userId: 'u-7' }, CURSOR],
      [{ userId: HEAVY_USER, areaId: AREA }, undefined],
      [{ areaId: AREA, from: new Date('2026-10-02T00:00:00Z') }, CURSOR],
      [{ userId: 'u-7', to: new Date('2026-10-02T00:00:00Z') }, undefined],
    ];

    for (const [filters, after] of combinations) {
      const nodes = await planOf(filters, after);
      expect(types(nodes)).not.toContain('Seq Scan');
      expect(indexes(nodes).length).toBeGreaterThan(0);
    }
  });
});
