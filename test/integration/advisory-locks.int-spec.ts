import { setTimeout as sleep } from 'node:timers/promises';
import type { DataSource } from 'typeorm';
import { tryAdvisoryXactLock, withAdvisoryLock } from '../../src/core/database/advisory-locks.js';
import { createTestDataSource } from '../support/test-env.js';

const TEST_LOCK = 999_000_001;

describe('withAdvisoryLock (integration)', () => {
  let first: DataSource;
  let second: DataSource;

  beforeAll(async () => {
    // Two independent pools stand in for two processes (e.g. two migration runners).
    [first, second] = await Promise.all([createTestDataSource(), createTestDataSource()]);
  });

  afterAll(async () => {
    await Promise.all([first.destroy(), second.destroy()]);
  });

  it('serialises holders across processes', async () => {
    const events: string[] = [];

    const holderA = withAdvisoryLock(first, TEST_LOCK, async () => {
      events.push('A:start');
      await sleep(300);
      events.push('A:end');
    });
    await sleep(50); // let A acquire the lock first
    const holderB = withAdvisoryLock(second, TEST_LOCK, async () => {
      events.push('B:start');
      events.push('B:end');
    });

    await Promise.all([holderA, holderB]);

    expect(events).toEqual(['A:start', 'A:end', 'B:start', 'B:end']);
  });

  it('releases the lock when the work fails', async () => {
    await expect(
      withAdvisoryLock(first, TEST_LOCK, () => Promise.reject(new Error('boom'))),
    ).rejects.toThrow('boom');

    await expect(
      withAdvisoryLock(second, TEST_LOCK, () => Promise.resolve('acquired')),
    ).resolves.toBe('acquired');
  });
});

describe('tryAdvisoryXactLock (integration)', () => {
  let first: DataSource;
  let second: DataSource;

  beforeAll(async () => {
    [first, second] = await Promise.all([createTestDataSource(), createTestDataSource()]);
  });

  afterAll(async () => {
    await Promise.all([first.destroy(), second.destroy()]);
  });

  it('gives the lock to one transaction at a time and releases it when that transaction ends', async () => {
    const otherTries: boolean[] = [];

    const holder = await first.transaction(async (manager) => {
      const taken = await tryAdvisoryXactLock(manager, TEST_LOCK);
      // Does not wait: another process learns at once that the lock is held.
      otherTries.push(await second.transaction((other) => tryAdvisoryXactLock(other, TEST_LOCK)));
      return taken;
    });
    otherTries.push(await second.transaction((other) => tryAdvisoryXactLock(other, TEST_LOCK)));

    expect(holder).toBe(true);
    expect(otherTries).toEqual([false, true]);
  });

  it('is released by a rollback', async () => {
    await expect(
      first.transaction(async (manager) => {
        await tryAdvisoryXactLock(manager, TEST_LOCK);
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    await expect(
      second.transaction((manager) => tryAdvisoryXactLock(manager, TEST_LOCK)),
    ).resolves.toBe(true);
  });

  it('refuses to run outside a transaction, where it would be released immediately', async () => {
    await expect(tryAdvisoryXactLock(first.manager, TEST_LOCK)).rejects.toThrow(
      'needs an active transaction',
    );
  });
});
