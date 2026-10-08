import type { DataSource, EntityManager } from 'typeorm';

/**
 * PostgreSQL advisory lock keys owned by this service. Each key must be unique per purpose.
 * Advisory locks are tied to the database session: if the holder crashes, the lock is released.
 */
export const AdvisoryLock = {
  Migrations: 727_100_001,
  OutboxRelay: 727_100_002,
  Housekeeping: 727_100_003,
} as const;

/**
 * Runs `work` while holding a session-level advisory lock, waiting for it if another process holds it.
 * The lock is taken on a dedicated connection that stays open until `work` finishes.
 */
export async function withAdvisoryLock<T>(
  dataSource: DataSource,
  lockKey: number,
  work: () => Promise<T>,
): Promise<T> {
  const queryRunner = dataSource.createQueryRunner();
  await queryRunner.connect();
  try {
    await queryRunner.query('SELECT pg_advisory_lock($1)', [lockKey]);
    try {
      return await work();
    } finally {
      await queryRunner.query('SELECT pg_advisory_unlock($1)', [lockKey]);
    }
  } finally {
    await queryRunner.release();
  }
}

/**
 * Tries to take a transaction-level advisory lock without waiting, and returns whether it was taken.
 *
 * The lock belongs to the caller's transaction and is released when it ends: commit, rollback, or the
 * server terminating the session (e.g. `idle_in_transaction_session_timeout` after the holder's host
 * died). A holder that disappears therefore cannot keep the lock for longer than that timeout.
 */
export async function tryAdvisoryXactLock(
  manager: EntityManager,
  lockKey: number,
): Promise<boolean> {
  if (!manager.queryRunner?.isTransactionActive) {
    throw new Error('A transaction-level advisory lock needs an active transaction');
  }
  // Raw SQL: TypeORM has no API for advisory locks.
  const rows: unknown = await manager.query('SELECT pg_try_advisory_xact_lock($1) AS locked', [
    lockKey,
  ]);
  const [row]: unknown[] = Array.isArray(rows) ? rows : [];
  return typeof row === 'object' && row !== null && 'locked' in row && row.locked === true;
}
