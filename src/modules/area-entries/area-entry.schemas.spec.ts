import { filtersFingerprint } from './area-entries.service.js';
import { listLogsQuerySchema } from './area-entry.schemas.js';

const AREA_ID = '01920000-0000-7000-8000-000000000001';

describe('listLogsQuerySchema', () => {
  it('parses the filters and applies the default limit', () => {
    expect(
      listLogsQuerySchema.parse({
        userId: 'u-42',
        areaId: AREA_ID,
        from: '2026-10-08T12:00:00+03:00',
        to: '2026-10-08T10:00:00Z',
      }),
    ).toEqual({
      userId: 'u-42',
      areaId: AREA_ID,
      from: new Date('2026-10-08T09:00:00Z'),
      to: new Date('2026-10-08T10:00:00Z'),
      limit: 50,
    });
  });

  it('rejects a range that ends before it starts, at the "to" field', () => {
    const result = listLogsQuerySchema.safeParse({
      from: '2026-10-08T10:00:00Z',
      to: '2026-10-08T10:00:00Z',
    });

    expect(result.error?.issues).toMatchObject([
      { path: ['to'], message: 'must be later than from' },
    ]);
  });

  it.each([
    [{ userId: 'u 42' }, ['userId']],
    [{ areaId: 'not-a-uuid' }, ['areaId']],
    // No offset: the instant would depend on the server's time zone.
    [{ from: '2026-10-08T10:00:00' }, ['from']],
    [{ limit: '501' }, ['limit']],
    // A misspelled filter (unknown keys are reported on the object itself).
    [{ userID: 'u-42' }, []],
  ])('rejects %o', (query, path) => {
    const result = listLogsQuerySchema.safeParse(query);

    expect(result.error?.issues[0]?.path).toEqual(path);
  });
});

describe('filtersFingerprint', () => {
  it('is equal for the same instants written with different offsets', () => {
    expect(filtersFingerprint({ from: new Date('2026-10-08T12:00:00+03:00') })).toBe(
      filtersFingerprint({ from: new Date('2026-10-08T09:00:00Z') }),
    );
  });

  it('differs for different filters, including a filter moved to another field', () => {
    const fingerprints = new Set([
      filtersFingerprint({}),
      filtersFingerprint({ userId: 'u-1' }),
      filtersFingerprint({ userId: 'u-2' }),
      filtersFingerprint({ areaId: AREA_ID }),
      filtersFingerprint({ from: new Date(0) }),
      filtersFingerprint({ to: new Date(0) }),
    ]);

    expect(fingerprints.size).toBe(6);
  });
});
