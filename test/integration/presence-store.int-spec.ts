import type { DataSource } from 'typeorm';
import type { RequestContext } from '../../src/core/context/request-context.js';
import { SystemClock } from '../../src/core/foundation/clock.js';
import { UuidV7Generator } from '../../src/core/foundation/id-generator.js';
import { AreaEntryEntity } from '../../src/modules/area-entries/area-entry.entity.js';
import { AreaEntity } from '../../src/modules/areas/area.entity.js';
import { PresenceStore } from '../../src/modules/entry-detection/presence-store.js';
import { OutboxEventEntity } from '../../src/modules/outbox/outbox-event.entity.js';
import { OutboxWriter } from '../../src/modules/outbox/outbox-writer.js';
import { UserAreaPresenceEntity } from '../../src/modules/presence/user-area-presence.entity.js';
import { UserTrackingStateEntity } from '../../src/modules/presence/user-tracking-state.entity.js';
import { createTestDataSource, truncateAllTables } from '../support/test-env.js';

const ids = new UuidV7Generator();
const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 8, 12, 0) + minutes * 60_000);

describe('PresenceStore (integration)', () => {
  let dataSource: DataSource;
  let store: PresenceStore;
  let areaA: string;
  let areaB: string;

  const count = (entity: new () => object): Promise<number> =>
    dataSource.getRepository(entity).count();

  beforeAll(async () => {
    dataSource = await createTestDataSource();
    const outbox = new OutboxWriter(ids, new SystemClock(), {
      correlationId: undefined,
    } as RequestContext);
    store = new PresenceStore(dataSource, outbox, ids);
  });

  beforeEach(async () => {
    await truncateAllTables(dataSource);
    [areaA, areaB] = [ids.next(), ids.next()];
    const now = new Date();
    for (const [id, name] of [
      [areaA, 'A'],
      [areaB, 'B'],
    ] as const) {
      await dataSource.getRepository(AreaEntity).insert({
        id,
        name,
        description: null,
        createdAt: now,
        updatedAt: now,
        geometry: {
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
        },
      });
    }
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('records an entry with its presence row and area.entered event', async () => {
    const result = await store.record({ userId: 'u1', entered: [areaA], exited: [], at: at(0) });

    expect(result).toEqual({ entries: 1, exits: 0 });
    const [entry] = await dataSource.getRepository(AreaEntryEntity).find();
    expect(entry).toMatchObject({ userId: 'u1', areaId: areaA, enteredAt: at(0), exitedAt: null });
    expect(await dataSource.getRepository(UserAreaPresenceEntity).find()).toMatchObject([
      { userId: 'u1', areaId: areaA, entryId: entry?.id },
    ]);
    expect(await dataSource.getRepository(OutboxEventEntity).find()).toMatchObject([
      {
        topic: 'area.entries.v1',
        messageKey: 'u1',
        eventType: 'area.entered',
        payload: { payload: { entryId: entry?.id, userId: 'u1', areaId: areaA } },
      },
    ]);
  });

  it('does not record an entry twice (redelivered ping or stale cache)', async () => {
    await store.record({ userId: 'u1', entered: [areaA], exited: [], at: at(0) });

    const again = await store.record({ userId: 'u1', entered: [areaA], exited: [], at: at(1) });

    expect(again).toEqual({ entries: 0, exits: 0 });
    expect(await count(AreaEntryEntity)).toBe(1);
    expect(await count(OutboxEventEntity)).toBe(1);
  });

  it('records an exit once, closing the entry and publishing area.exited', async () => {
    await store.record({ userId: 'u1', entered: [areaA], exited: [], at: at(0) });
    const exit = { userId: 'u1', entered: [], exited: [{ areaId: areaA, exitedAt: at(5) }] };

    expect(await store.record({ ...exit, at: at(5) })).toEqual({ entries: 0, exits: 1 });
    expect(await store.record({ ...exit, at: at(6) })).toEqual({ entries: 0, exits: 0 });

    expect(await dataSource.getRepository(AreaEntryEntity).find()).toMatchObject([
      { exitedAt: at(5) },
    ]);
    expect(await count(UserAreaPresenceEntity)).toBe(0);
    const events = await dataSource.getRepository(OutboxEventEntity).find({
      order: { createdAt: 'ASC' },
    });
    expect(events.map((event) => event.eventType).toSorted()).toEqual([
      'area.entered',
      'area.exited',
    ]);
  });

  it('closes a stale session and opens a new one in the same area in one transaction', async () => {
    await store.record({ userId: 'u1', entered: [areaA], exited: [], at: at(0) });

    const result = await store.record({
      userId: 'u1',
      entered: [areaA],
      exited: [{ areaId: areaA, exitedAt: at(1) }],
      at: at(30),
    });

    expect(result).toEqual({ entries: 1, exits: 1 });
    const entries = await dataSource
      .getRepository(AreaEntryEntity)
      .find({ order: { enteredAt: 'ASC' } });
    expect(entries).toMatchObject([
      { enteredAt: at(0), exitedAt: at(1) },
      { enteredAt: at(30), exitedAt: null },
    ]);
  });

  it('never records an exit before its entry, whatever the cached state said', async () => {
    await store.record({ userId: 'u1', entered: [areaA], exited: [], at: at(10) });

    await store.record({
      userId: 'u1',
      entered: [],
      exited: [{ areaId: areaA, exitedAt: at(5) }],
      at: at(11),
    });

    expect(await dataSource.getRepository(AreaEntryEntity).find()).toMatchObject([
      { enteredAt: at(10), exitedAt: at(10) },
    ]);
  });

  it('only moves the transition watermark forward', async () => {
    await store.record({ userId: 'u1', entered: [areaA], exited: [], at: at(10) });
    await store.record({ userId: 'u1', entered: [areaB], exited: [], at: at(5) });

    expect(await dataSource.getRepository(UserTrackingStateEntity).find()).toMatchObject([
      { userId: 'u1', lastTransitionAt: at(10) },
    ]);
  });

  it('rebuilds the state of a user from PostgreSQL', async () => {
    await store.record({ userId: 'u1', entered: [areaB, areaA], exited: [], at: at(3) });

    expect(await store.load('u1')).toEqual({
      areaIds: [areaA, areaB].toSorted(),
      lastPingAt: null,
      lastTransitionAt: at(3),
    });
    expect(await store.load('nobody')).toEqual({
      areaIds: [],
      lastPingAt: null,
      lastTransitionAt: null,
    });
  });

  it('still refuses a presence row without its entry, at commit time', async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        await manager.insert(UserAreaPresenceEntity, {
          userId: 'u1',
          areaId: areaA,
          entryId: ids.next(),
          enteredAt: at(0),
        });
      }),
    ).rejects.toMatchObject({ driverError: { code: '23503' } });
  });
});
