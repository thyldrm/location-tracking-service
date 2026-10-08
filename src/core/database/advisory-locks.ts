import type { DataSource } from 'typeorm';

/**
 * PostgreSQL advisory lock keys owned by this service. Each key must be unique per purpose.
 * Advisory locks are tied to the database session: if the holder crashes, the lock is released.
 */
export const AdvisoryLock = {
  Migrations: 727_100_001,
  OutboxRelay: 727_100_002,
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
