import type { DataSource } from 'typeorm';
import { UnprocessableError } from '../../src/core/errors/app-errors.js';
import { IdempotencyKeyEntity } from '../../src/modules/idempotency/idempotency-key.entity.js';
import {
  type IdempotencyRequest,
  IdempotencyStore,
} from '../../src/modules/idempotency/idempotency-store.js';
import { createTestDataSource, truncateAllTables } from '../support/test-env.js';

const request = (overrides: Partial<IdempotencyRequest> = {}): IdempotencyRequest => ({
  scope: 'areas.create',
  key: 'client-key-1',
  resourceId: '0199b1a2-0000-7000-8000-000000000001',
  requestHash: 'a'.repeat(64),
  ...overrides,
});

describe('IdempotencyStore (integration)', () => {
  let dataSource: DataSource;
  const store = new IdempotencyStore();

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  beforeEach(async () => {
    await truncateAllTables(dataSource);
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('claims an unused key and replays it afterwards', async () => {
    const first = await dataSource.transaction((manager) => store.claim(manager, request()));
    const second = await dataSource.transaction((manager) =>
      store.claim(manager, request({ resourceId: '0199b1a2-0000-7000-8000-000000000002' })),
    );

    expect(first).toEqual({ status: 'claimed' });
    expect(second).toEqual({
      status: 'replay',
      resourceId: '0199b1a2-0000-7000-8000-000000000001',
    });
  });

  it('rejects the same key with a different request', async () => {
    await dataSource.transaction((manager) => store.claim(manager, request()));

    await expect(
      dataSource.transaction((manager) =>
        store.claim(manager, request({ requestHash: 'b'.repeat(64) })),
      ),
    ).rejects.toBeInstanceOf(UnprocessableError);
  });

  it('keeps keys of different scopes apart', async () => {
    await dataSource.transaction((manager) => store.claim(manager, request()));

    const other = await dataSource.transaction((manager) =>
      store.claim(manager, request({ scope: 'other.create' })),
    );

    expect(other).toEqual({ status: 'claimed' });
  });

  it('forgets a claim whose transaction rolled back', async () => {
    await expect(
      dataSource.transaction(async (manager) => {
        await store.claim(manager, request());
        throw new Error('creating the resource failed');
      }),
    ).rejects.toThrow('creating the resource failed');

    const retry = await dataSource.transaction((manager) => store.claim(manager, request()));
    expect(retry).toEqual({ status: 'claimed' });
  });

  it('lets exactly one of two concurrent requests with the same key claim it', async () => {
    // The first transaction holds its uncommitted claim while the second one tries to claim the key.
    let releaseFirst!: () => void;
    const firstMayCommit = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = dataSource.transaction(async (manager) => {
      const claim = await store.claim(manager, request());
      await firstMayCommit;
      return claim;
    });
    // Give the first insert time to reach the database before the second one starts.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = dataSource.transaction((manager) =>
      store.claim(manager, request({ resourceId: '0199b1a2-0000-7000-8000-000000000002' })),
    );
    // The second insert is now blocked on the first transaction's row lock.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseFirst();

    expect(await first).toEqual({ status: 'claimed' });
    expect(await second).toEqual({
      status: 'replay',
      resourceId: '0199b1a2-0000-7000-8000-000000000001',
    });
    expect(await dataSource.getRepository(IdempotencyKeyEntity).count()).toBe(1);
  });
});
