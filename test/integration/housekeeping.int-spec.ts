import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import type { Env } from '../../src/core/config/env.schema.js';
import { AdvisoryLock, tryAdvisoryXactLock } from '../../src/core/database/advisory-locks.js';
import { UuidV7Generator } from '../../src/core/foundation/id-generator.js';
import { Topics } from '../../src/core/messaging/topics.js';
import {
  HOUSEKEEPING_CHUNK_SIZE,
  HousekeepingService,
} from '../../src/modules/housekeeping/housekeeping.service.js';
import { IdempotencyKeyEntity } from '../../src/modules/idempotency/idempotency-key.entity.js';
import { IdempotencyStore } from '../../src/modules/idempotency/idempotency-store.js';
import { OutboxEventEntity } from '../../src/modules/outbox/outbox-event.entity.js';
import { createTestDataSource, truncateAllTables } from '../support/test-env.js';

const ids = new UuidV7Generator();
const NOW = new Date(Date.UTC(2026, 9, 8, 12, 0));
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const ago = (ms: number): Date => new Date(NOW.getTime() - ms);

const settings: Partial<Env> = {
  OUTBOX_RETENTION_MS: 7 * DAY,
  IDEMPOTENCY_KEY_TTL_MS: DAY,
};

function outboxEvent(createdAt: Date, publishedAt: Date | null) {
  const id = ids.next();
  return {
    id,
    topic: Topics.AreaEntries,
    messageKey: 'u1',
    eventType: 'area.entered',
    payload: { eventId: id },
    createdAt,
    publishedAt,
  };
}

function idempotencyKey(key: string, createdAt: Date) {
  return {
    scope: 'areas.create',
    key,
    resourceId: ids.next(),
    requestHash: 'a'.repeat(64),
    createdAt,
  };
}

describe('HousekeepingService (integration)', () => {
  let dataSource: DataSource;
  let other: DataSource;
  let housekeeping: HousekeepingService;

  beforeAll(async () => {
    [dataSource, other] = await Promise.all([createTestDataSource(), createTestDataSource()]);
    housekeeping = new HousekeepingService(
      dataSource,
      new IdempotencyStore(),
      { now: () => NOW },
      { get: (key: keyof Env) => settings[key] } as ConfigService<Env, true>,
      { info: vi.fn<() => void>(), warn: vi.fn<() => void>() } as unknown as PinoLogger,
    );
  });

  beforeEach(async () => {
    await truncateAllTables(dataSource);
  });

  afterAll(async () => {
    await Promise.all([dataSource.destroy(), other.destroy()]);
  });

  it('deletes expired rows only, and never an unpublished event', async () => {
    const expired = outboxEvent(ago(9 * DAY), ago(8 * DAY));
    const recent = outboxEvent(ago(2 * DAY), ago(2 * DAY));
    const neverPublished = outboxEvent(ago(30 * DAY), null);
    await dataSource.getRepository(OutboxEventEntity).insert([expired, recent, neverPublished]);
    await dataSource
      .getRepository(IdempotencyKeyEntity)
      .insert([idempotencyKey('old', ago(25 * HOUR)), idempotencyKey('fresh', ago(HOUR))]);

    expect(await housekeeping.runOnce()).toEqual({
      status: 'done',
      outboxEvents: 1,
      idempotencyKeys: 1,
    });

    const remainingEvents = await dataSource.getRepository(OutboxEventEntity).find();
    expect(remainingEvents.map((event) => event.id).toSorted()).toEqual(
      [recent.id, neverPublished.id].toSorted(),
    );
    const remainingKeys = await dataSource.getRepository(IdempotencyKeyEntity).find();
    expect(remainingKeys.map((key) => key.key)).toEqual(['fresh']);
  });

  it('deletes in chunks until nothing expired is left', async () => {
    const rows = Array.from({ length: HOUSEKEEPING_CHUNK_SIZE * 2 + 500 }, () =>
      outboxEvent(ago(9 * DAY), ago(8 * DAY)),
    );
    await dataSource.getRepository(OutboxEventEntity).insert(rows);

    expect(await housekeeping.runOnce()).toMatchObject({ outboxEvents: rows.length });
    expect(await dataSource.getRepository(OutboxEventEntity).count()).toBe(0);
  });

  it('leaves the work to the instance that is already cleaning up', async () => {
    await dataSource
      .getRepository(OutboxEventEntity)
      .insert(outboxEvent(ago(9 * DAY), ago(8 * DAY)));

    const result = await other.transaction(async (manager) => {
      await tryAdvisoryXactLock(manager, AdvisoryLock.Housekeeping);
      return housekeeping.runOnce();
    });

    expect(result).toEqual({ status: 'skipped' });
    expect(await dataSource.getRepository(OutboxEventEntity).count()).toBe(1);
  });
});
