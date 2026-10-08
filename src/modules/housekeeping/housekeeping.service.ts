import { setTimeout as sleep } from 'node:timers/promises';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import type { Env } from '../../core/config/env.schema.js';
import { AdvisoryLock, tryAdvisoryXactLock } from '../../core/database/advisory-locks.js';
import { Clock } from '../../core/foundation/clock.js';
import { IdempotencyStore } from '../idempotency/idempotency-store.js';
import { deletePublishedOutboxEvents } from '../outbox/outbox-retention.js';

/** Rows deleted per transaction. */
export const HOUSEKEEPING_CHUNK_SIZE = 1_000;

export type HousekeepingResult =
  | { status: 'done'; outboxEvents: number; idempotencyKeys: number }
  /** Another instance is running the housekeeping. */
  | { status: 'skipped' };

type Task = {
  name: 'outboxEvents' | 'idempotencyKeys';
  deleteChunk: (manager: EntityManager, now: Date) => Promise<number>;
};

/**
 * Deletes data that has served its purpose (SPEC.md §9): published outbox events after
 * `OUTBOX_RETENTION_MS`, idempotency keys after `IDEMPOTENCY_KEY_TTL_MS`. Runs in the worker at startup
 * and then every `HOUSEKEEPING_INTERVAL_MS`.
 *
 * - Deletes in chunks of 1,000 rows, one short transaction each: one huge `DELETE` would hold its locks
 *   and its transaction for a long time and produce a burst of WAL and dead rows.
 * - Every chunk takes a transaction-level advisory lock; an instance that does not get it stops, since
 *   another one is already cleaning up.
 */
@Injectable()
export class HousekeepingService implements OnApplicationBootstrap, OnApplicationShutdown {
  private running: Promise<void> | undefined;
  private readonly stop = new AbortController();
  private readonly tasks: Task[];

  constructor(
    private readonly dataSource: DataSource,
    idempotency: IdempotencyStore,
    private readonly clock: Clock,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(HousekeepingService.name) private readonly logger: PinoLogger,
  ) {
    const outboxRetentionMs = config.get('OUTBOX_RETENTION_MS', { infer: true });
    const idempotencyKeyTtlMs = config.get('IDEMPOTENCY_KEY_TTL_MS', { infer: true });
    this.tasks = [
      {
        name: 'outboxEvents',
        deleteChunk: (manager, now) =>
          deletePublishedOutboxEvents(
            manager,
            new Date(now.getTime() - outboxRetentionMs),
            HOUSEKEEPING_CHUNK_SIZE,
          ),
      },
      {
        name: 'idempotencyKeys',
        deleteChunk: (manager, now) =>
          idempotency.deleteCreatedBefore(
            manager,
            new Date(now.getTime() - idempotencyKeyTtlMs),
            HOUSEKEEPING_CHUNK_SIZE,
          ),
      },
    ];
  }

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.running;
  }

  /** One complete clean-up. */
  async runOnce(): Promise<HousekeepingResult> {
    const now = this.clock.now();
    const deleted = { outboxEvents: 0, idempotencyKeys: 0 };
    for (const task of this.tasks) {
      for (;;) {
        if (this.stop.signal.aborted) {
          return { status: 'done', ...deleted };
        }
        const count = await this.dataSource.transaction(async (manager) =>
          (await tryAdvisoryXactLock(manager, AdvisoryLock.Housekeeping))
            ? task.deleteChunk(manager, now)
            : undefined,
        );
        if (count === undefined) {
          return { status: 'skipped' };
        }
        deleted[task.name] += count;
        if (count < HOUSEKEEPING_CHUNK_SIZE) {
          break;
        }
      }
    }
    return { status: 'done', ...deleted };
  }

  private async run(): Promise<void> {
    const intervalMs = this.config.get('HOUSEKEEPING_INTERVAL_MS', { infer: true });
    while (!this.stop.signal.aborted) {
      try {
        const result = await this.runOnce();
        if (result.status === 'done' && result.outboxEvents + result.idempotencyKeys > 0) {
          this.logger.info(result, 'Housekeeping deleted expired rows');
        }
      } catch (error) {
        // Nothing depends on a single run; the next one catches up.
        this.logger.warn({ err: error }, 'Housekeeping failed; retrying at the next interval');
      }
      await sleep(intervalMs, undefined, { signal: this.stop.signal }).catch(() => undefined);
    }
  }
}
