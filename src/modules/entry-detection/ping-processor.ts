import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Env } from '../../core/config/env.schema.js';
import { AreaIndexService } from '../area-index/area-index.service.js';
import type { PingMessage } from '../locations/ping-message.js';
import { PresenceCache } from './presence-cache.js';
import { PresenceStore } from './presence-store.js';
import { evaluatePing } from './presence-transition.js';

export type PingOutcome = 'out-of-order' | 'unchanged' | 'transition';

/**
 * Processes one ping of one user (SPEC.md §8, step 3). The caller guarantees that pings of the same user
 * are processed one at a time and in order (they come from one partition).
 */
@Injectable()
export class PingProcessor {
  private readonly presenceTtlMs: number;

  constructor(
    private readonly areaIndex: AreaIndexService,
    private readonly cache: PresenceCache,
    private readonly store: PresenceStore,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(PingProcessor.name) private readonly logger: PinoLogger,
  ) {
    this.presenceTtlMs = config.get('PRESENCE_TTL_MS', { infer: true });
  }

  async process(ping: PingMessage): Promise<PingOutcome> {
    const timestamp = new Date(ping.timestamp);
    const current = this.areaIndex.areasContaining(ping.longitude, ping.latitude);
    const previous = (await this.cache.get(ping.userId)) ?? (await this.store.load(ping.userId));

    const evaluation = evaluatePing(previous, current, timestamp, this.presenceTtlMs);
    if (evaluation.kind === 'out-of-order') {
      return 'out-of-order';
    }
    if (evaluation.kind === 'unchanged') {
      // The common case: nothing is written to PostgreSQL.
      await this.cache.set(ping.userId, evaluation.state);
      return 'unchanged';
    }

    // Without this, a crash between the commit and the cache update would leave a stale cache.
    await this.cache.delete(ping.userId);
    const recorded = await this.store.record({
      userId: ping.userId,
      entered: evaluation.entered,
      exited: evaluation.exited,
      at: timestamp,
    });
    await this.cache.set(ping.userId, evaluation.state);
    // No coordinates: location is personal data and stays out of the logs.
    this.logger.debug({ userId: ping.userId, ...recorded }, 'Presence changed');
    return 'transition';
  }
}
