import { setTimeout as sleep } from 'node:timers/promises';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource, In, IsNull, LessThan } from 'typeorm';
import type { Env } from '../../core/config/env.schema.js';
import { AdvisoryLock, tryAdvisoryXactLock } from '../../core/database/advisory-locks.js';
import { backoffDelayMs, withJitter } from '../../core/foundation/backoff.js';
import { MessageProducer, PublishError } from '../../core/messaging/message-producer.js';
import { Metrics } from '../../core/metrics/metrics.js';
import { isTopic } from '../../core/messaging/topics.js';
import { OutboxEventEntity } from './outbox-event.entity.js';
import { publishInKeyOrder } from './publish-in-key-order.js';

const BACKOFF = { baseMs: 500, maxMs: 30_000 };
const LAST_ERROR_MAX_LENGTH = 1_000;

/** Outcome of one relay pass. */
export type RelayPass =
  /** Another instance holds the relay lock; this one stays on standby. */
  | { role: 'standby' }
  | {
      role: 'leader';
      fetched: number;
      published: number;
      /** Refused by the broker (or not publishable at all); counted on the row. */
      rejected: number;
      /** Not published because the broker was unreachable or slow; retried, not counted. */
      unavailable: number;
    };

/** A rejection is about the event itself; anything else is about the broker's availability. */
function isRejection(error: unknown): boolean {
  return !(error instanceof PublishError) || error.reason === 'rejected';
}

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, LAST_ERROR_MAX_LENGTH);
}

/**
 * Outbox relay (SPEC.md §9): publishes the events written to `outbox_events` to Kafka.
 *
 * Each pass is one database transaction:
 * 1. `pg_try_advisory_xact_lock`: one instance relays at a time, the others stay on standby and try again
 *    at the next poll. The lock ends with the transaction, so a relay that dies is replaced at the latest
 *    after `idle_in_transaction_session_timeout`, without a failure detector of our own.
 * 2. Read the oldest unpublished rows in `(created_at, id)` order.
 * 3. Publish them, in order per message key (`publishInKeyOrder`).
 * 4. Mark the acknowledged rows as published, count the rejections on the rejected rows, commit.
 *
 * A crash between 3 and 4 publishes those rows again on the next pass: delivery is at least once, and
 * consumers deduplicate by `eventId`.
 *
 * Failures:
 * - Kafka unreachable or slow (`unavailable`, `timeout`, `queue-full`): the rows are left as they are and
 *   the relay backs off; an outage of any length never uses up attempts.
 * - The broker rejects an event (or its topic is unknown): `attempts` + 1 and `last_error`. An event
 *   rejected `OUTBOX_MAX_ATTEMPTS` times is no longer selected ("parked"), so it cannot block the relay;
 *   it stays in the table for an operator.
 */
@Injectable()
export class OutboxRelay implements OnApplicationBootstrap, OnApplicationShutdown {
  private running: Promise<void> | undefined;
  private readonly stop = new AbortController();
  private consecutiveFailures = 0;

  constructor(
    private readonly dataSource: DataSource,
    private readonly producer: MessageProducer,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(OutboxRelay.name) private readonly logger: PinoLogger,
    private readonly metrics: Metrics,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.run();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    // Lets the pass in progress finish: what it published is then also marked as published.
    await this.running;
  }

  /** One relay pass, in one transaction. */
  async relayOnce(): Promise<RelayPass> {
    const batchSize = this.config.get('OUTBOX_BATCH_SIZE', { infer: true });
    const maxAttempts = this.config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });

    return this.dataSource.transaction(async (manager) => {
      if (!(await tryAdvisoryXactLock(manager, AdvisoryLock.OutboxRelay))) {
        return { role: 'standby' };
      }

      // Served by idx_outbox_events_unpublished (created_at, id) WHERE published_at IS NULL.
      const rows = await manager.find(OutboxEventEntity, {
        where: { publishedAt: IsNull(), attempts: LessThan(maxAttempts) },
        order: { createdAt: 'ASC', id: 'ASC' },
        take: batchSize,
      });
      const { published, failed } = await publishInKeyOrder(rows, (row) => this.publish(row));

      if (published.length > 0) {
        await manager.update(
          OutboxEventEntity,
          { id: In(published.map((row) => row.id)) },
          { publishedAt: () => 'now()' },
        );
      }
      const rejected = failed.filter(({ error }) => isRejection(error));
      for (const { row, error } of rejected) {
        await manager.update(
          OutboxEventEntity,
          { id: row.id },
          { attempts: () => 'attempts + 1', lastError: errorText(error) },
        );
        this.logRejection(row, error, maxAttempts);
      }

      this.metrics.outboxPublished.inc(published.length);
      this.metrics.outboxPublishFailures.inc({ kind: 'rejected' }, rejected.length);
      this.metrics.outboxPublishFailures.inc(
        { kind: 'unavailable' },
        failed.length - rejected.length,
      );
      return {
        role: 'leader',
        fetched: rows.length,
        published: published.length,
        rejected: rejected.length,
        unavailable: failed.length - rejected.length,
      };
    });
  }

  private async publish(row: OutboxEventEntity): Promise<void> {
    if (!isTopic(row.topic)) {
      throw new Error(`Unknown topic "${row.topic}"`);
    }
    await this.producer.publish(row.topic, {
      key: row.messageKey,
      value: JSON.stringify(row.payload),
      headers: row.headers,
    });
  }

  private async run(): Promise<void> {
    const pollIntervalMs = this.config.get('OUTBOX_POLL_INTERVAL_MS', { infer: true });
    const batchSize = this.config.get('OUTBOX_BATCH_SIZE', { infer: true });

    while (!this.stop.signal.aborted) {
      let delayMs = pollIntervalMs;
      // Until the producer is connected there is nothing to try. The outage is reported by the producer
      // itself, where it is detected; the relay just waits for the next poll.
      if (this.producer.isConnected()) {
        try {
          const pass = await this.relayOnce();
          if (pass.role === 'leader' && pass.unavailable > 0) {
            delayMs = this.backOff(
              { unavailable: pass.unavailable },
              'Kafka did not accept events',
            );
          } else {
            this.consecutiveFailures = 0;
            if (pass.role === 'leader' && pass.published > 0) {
              this.logger.debug(pass, 'Outbox events published');
            }
            // A full batch without failures suggests a backlog: drain it without pausing.
            if (pass.role === 'leader' && pass.published === batchSize) {
              delayMs = 0;
            }
          }
        } catch (error) {
          delayMs = this.backOff({ err: error }, 'Outbox relay pass failed');
        }
      }
      if (delayMs > 0) {
        await sleep(delayMs, undefined, { signal: this.stop.signal }).catch(() => undefined);
      }
    }
  }

  /** Counts a failed pass, logs it and returns how long to wait before the next one. */
  private backOff(fields: object, message: string): number {
    this.consecutiveFailures++;
    const delayMs = withJitter(backoffDelayMs(this.consecutiveFailures, BACKOFF));
    this.logger.warn(
      {
        ...fields,
        consecutiveFailures: this.consecutiveFailures,
        retryInMs: Math.round(delayMs),
      },
      `${message}; retrying`,
    );
    return delayMs;
  }

  private logRejection(row: OutboxEventEntity, error: unknown, maxAttempts: number): void {
    const attempts = row.attempts + 1;
    const fields = {
      err: error,
      eventId: row.id,
      eventType: row.eventType,
      topic: row.topic,
      attempts,
    };
    if (attempts >= maxAttempts) {
      this.logger.error(fields, 'Outbox event parked after repeated rejections; needs an operator');
    } else {
      this.logger.warn(fields, 'Outbox event rejected; it will be retried');
    }
  }
}
