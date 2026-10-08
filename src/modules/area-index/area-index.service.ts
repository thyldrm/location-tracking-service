import { setTimeout as sleep } from 'node:timers/promises';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Repository } from 'typeorm';
import type { Env } from '../../core/config/env.schema.js';
import { AreaEntity } from '../areas/area.entity.js';
import { AreaIndex } from './area-index.js';

const RETRY_DELAY_MS = 5_000;

/**
 * Owns the worker's in-memory area index (SPEC.md §8, "Area index").
 *
 * - Loaded fully from PostgreSQL at startup. Until then the worker must not process pings: an empty index
 *   would make every user "exit" every area. `whenReady()` lets the consumer wait for it.
 * - Reloaded every `AREA_INDEX_REFRESH_MS`, so a new area is picked up within that time even if its
 *   `area.created` event is missed. A failed reload keeps serving the previous index.
 * - Each load builds a new immutable index and swaps the reference: readers never see a half-built one.
 */
@Injectable()
export class AreaIndexService implements OnApplicationBootstrap, OnApplicationShutdown {
  private index: AreaIndex | undefined;
  private readonly ready = Promise.withResolvers<void>();
  private readonly stop = new AbortController();
  private refreshing: Promise<void> | undefined;

  constructor(
    @InjectRepository(AreaEntity) private readonly areas: Repository<AreaEntity>,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(AreaIndexService.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.refreshing = this.loadAndRefresh();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.refreshing;
  }

  isReady(): boolean {
    return this.index !== undefined;
  }

  /** Resolves once the first load has succeeded; rejects if the process shuts down first. */
  async whenReady(signal: AbortSignal): Promise<void> {
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error('Stopped before the area index was ready')),
        {
          once: true,
        },
      );
    });
    await Promise.race([this.ready.promise, aborted]);
  }

  /** Ids of the areas covering the point. Only valid once ready. */
  areasContaining(longitude: number, latitude: number): string[] {
    if (!this.index) {
      throw new Error('The area index is not loaded yet');
    }
    return this.index.areasContaining(longitude, latitude);
  }

  /** Loads every area and replaces the index. Also called when an area is created (milestone 6). */
  async reload(): Promise<void> {
    const startedAt = performance.now();
    const areas = await this.areas.find({ select: { id: true, geometry: true } });
    this.index = AreaIndex.build(areas);
    this.ready.resolve();
    this.logger.info(
      { areas: areas.length, durationMs: Math.round(performance.now() - startedAt) },
      'Area index loaded',
    );
  }

  private async loadAndRefresh(): Promise<void> {
    const refreshMs = this.config.get('AREA_INDEX_REFRESH_MS', { infer: true });
    while (!this.stop.signal.aborted) {
      let delayMs = refreshMs;
      try {
        await this.reload();
      } catch (error) {
        // Before the first load, retry soon; afterwards the previous index keeps serving.
        delayMs = this.isReady() ? refreshMs : RETRY_DELAY_MS;
        this.logger.error({ err: error }, 'Area index could not be loaded');
      }
      await sleep(delayMs, undefined, { signal: this.stop.signal }).catch(() => undefined);
    }
  }
}
