import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { Env } from '../../core/config/env.schema.js';
import { Clock } from '../../core/foundation/clock.js';
import { ThrottledLog } from '../../core/logging/throttled-log.js';
import type { PresenceState } from './presence-transition.js';

const KEY_PREFIX = 'presence:';
const FAILURE_LOG_INTERVAL_MS = 60_000;

const isoDate = z.iso
  .datetime()
  .nullable()
  .transform((value) => (value === null ? null : new Date(value)));

const cachedStateSchema = z.object({
  areaIds: z.array(z.string()),
  lastPingAt: isoDate,
  lastTransitionAt: isoDate,
});

/**
 * Per-user presence state in Redis: the hot path of the worker. Most pings change nothing, and for those
 * the worker reads and writes Redis only, never PostgreSQL.
 *
 * Redis is a cache, not the source of truth: every failure is reported as a miss (`undefined`), and the
 * caller falls back to PostgreSQL. A cached state that is wrong cannot create wrong records either, because
 * the database guards (presence primary key, `DELETE ... RETURNING`) decide what is actually written.
 */
@Injectable()
export class PresenceCache {
  private readonly ttlMs: number;
  private readonly failureLog: ThrottledLog;

  constructor(
    private readonly redis: Redis,
    config: ConfigService<Env, true>,
    clock: Clock,
    @InjectPinoLogger(PresenceCache.name) private readonly logger: PinoLogger,
  ) {
    this.ttlMs = config.get('PRESENCE_STATE_TTL_MS', { infer: true });
    this.failureLog = new ThrottledLog(FAILURE_LOG_INTERVAL_MS, () => clock.now().getTime());
  }

  async get(userId: string): Promise<PresenceState | undefined> {
    try {
      const raw = await this.redis.get(KEY_PREFIX + userId);
      if (raw === null) {
        return undefined;
      }
      const parsed = cachedStateSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch (error) {
      this.reportFailure(error);
      return undefined;
    }
  }

  async set(userId: string, state: PresenceState): Promise<void> {
    const value = JSON.stringify({
      areaIds: state.areaIds,
      lastPingAt: state.lastPingAt?.toISOString() ?? null,
      lastTransitionAt: state.lastTransitionAt?.toISOString() ?? null,
    });
    try {
      await this.redis.set(KEY_PREFIX + userId, value, 'PX', this.ttlMs);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  /** Drops the cached state, so a failure after this point falls back to PostgreSQL, not to stale data. */
  async delete(userId: string): Promise<void> {
    try {
      await this.redis.del(KEY_PREFIX + userId);
    } catch (error) {
      this.reportFailure(error);
    }
  }

  private reportFailure(error: unknown): void {
    this.failureLog.record((suppressedSinceLastReport) =>
      this.logger.warn(
        { err: error, suppressedSinceLastReport },
        'Presence cache unavailable; using PostgreSQL',
      ),
    );
  }
}
