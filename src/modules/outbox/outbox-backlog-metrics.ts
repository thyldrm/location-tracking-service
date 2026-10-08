import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { Gauge } from 'prom-client';
import { DataSource } from 'typeorm';
import type { Env } from '../../core/config/env.schema.js';
import { Metrics } from '../../core/metrics/metrics.js';
import { OutboxEventEntity } from './outbox-event.entity.js';

type Backlog = { unpublished: number; parked: number; oldestAgeSeconds: number };

const UNKNOWN: Backlog = {
  unpublished: Number.NaN,
  parked: Number.NaN,
  oldestAgeSeconds: Number.NaN,
};

/** One scrape reads all three gauges; they share one query. */
const SNAPSHOT_REUSE_MS = 1_000;

/**
 * The outbox relay's health, read from the table at scrape time (SPEC.md §11):
 *
 * - `outbox_oldest_unpublished_age_seconds`: how late events are. The best single signal: it grows when the
 *   relay stops or cannot keep up, however busy the system is.
 * - `outbox_unpublished_events`: the backlog.
 * - `outbox_parked_events`: events rejected too often and no longer retried. Above zero means somebody is
 *   not receiving an event; alert on it.
 *
 * The query is served by the partial index on unpublished rows. Every worker reports the same values;
 * dashboards take the maximum. If the database is unreachable the gauges are NaN rather than a stale or
 * a zero value, which would look healthy.
 */
@Injectable()
export class OutboxBacklogMetrics implements OnModuleInit {
  private snapshot: { takenAt: number; backlog: Promise<Backlog> } | undefined;

  constructor(
    private readonly dataSource: DataSource,
    private readonly metrics: Metrics,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(OutboxBacklogMetrics.name) private readonly logger: PinoLogger,
  ) {}

  onModuleInit(): void {
    const gauge = (name: string, help: string, read: (backlog: Backlog) => number): void => {
      const metric: Gauge = new Gauge({
        name,
        help,
        registers: [this.metrics.registry],
        collect: async () => {
          metric.set(read(await this.backlog()));
        },
      });
    };
    gauge(
      'outbox_unpublished_events',
      'Outbox events waiting to be published (parked events excluded).',
      (backlog) => backlog.unpublished,
    );
    gauge(
      'outbox_oldest_unpublished_age_seconds',
      'Age of the oldest outbox event waiting to be published; 0 when there is none.',
      (backlog) => backlog.oldestAgeSeconds,
    );
    gauge(
      'outbox_parked_events',
      'Outbox events no longer retried after repeated broker rejections.',
      (backlog) => backlog.parked,
    );
  }

  private backlog(): Promise<Backlog> {
    const now = performance.now();
    if (!this.snapshot || now - this.snapshot.takenAt > SNAPSHOT_REUSE_MS) {
      this.snapshot = { takenAt: now, backlog: this.query() };
    }
    return this.snapshot.backlog;
  }

  private async query(): Promise<Backlog> {
    const maxAttempts = this.config.get('OUTBOX_MAX_ATTEMPTS', { infer: true });
    try {
      const row = await this.dataSource
        .createQueryBuilder(OutboxEventEntity, 'event')
        .select('count(*) FILTER (WHERE event.attempts < :maxAttempts)', 'unpublished')
        .addSelect('count(*) FILTER (WHERE event.attempts >= :maxAttempts)', 'parked')
        .addSelect(
          'EXTRACT(EPOCH FROM now() - min(event.createdAt) FILTER (WHERE event.attempts < :maxAttempts))',
          'oldestAgeSeconds',
        )
        .where('event.publishedAt IS NULL')
        .setParameters({ maxAttempts })
        .getRawOne<{ unpublished: string; parked: string; oldestAgeSeconds: string | null }>();
      return {
        unpublished: Number(row?.unpublished ?? 0),
        parked: Number(row?.parked ?? 0),
        oldestAgeSeconds: Number(row?.oldestAgeSeconds ?? 0),
      };
    } catch (error) {
      this.logger.debug({ err: error }, 'Outbox backlog could not be read for metrics');
      return UNKNOWN;
    }
  }
}
