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
import { DatabaseConnection } from '../../core/database/database-connection.js';
import { Metrics } from '../../core/metrics/metrics.js';
import { AreaEntity } from '../areas/area.entity.js';
import { AreaIndex, type IndexedArea } from './area-index.js';

const RETRY_DELAY_MS = 5_000;

/**
 * Owns the worker's in-memory area index (SPEC.md §8, "Area index").
 *
 * - Loaded fully from PostgreSQL at startup. Until then the worker must not process pings: an empty index
 *   would make every user "exit" every area. `whenReady()` lets the consumer wait for it.
 * - New areas are added from their `area.created` events as they arrive (`add`), without a database read.
 * - Reloaded every `AREA_INDEX_REFRESH_MS`, the safety net for a missed event. A failed reload keeps
 *   serving the previous index.
 * - Each change builds a new immutable index and swaps the reference: readers never see a half-built one.
 * - Reloads and additions run one at a time. Otherwise a reload that read the table just before an area
 *   was committed could finish after that area's event was applied, and drop it again.
 */
@Injectable()
export class AreaIndexService implements OnApplicationBootstrap, OnApplicationShutdown {
  private index: AreaIndex | undefined;
  private areas = new Map<string, IndexedArea>();
  /** Tail of the queue of index changes; each change starts when the previous one has settled. */
  private changes: Promise<unknown> = Promise.resolve();
  private readonly ready = Promise.withResolvers<void>();
  private readonly stop = new AbortController();
  private refreshing: Promise<void> | undefined;

  constructor(
    @InjectRepository(AreaEntity) private readonly repository: Repository<AreaEntity>,
    private readonly database: DatabaseConnection,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(AreaIndexService.name) private readonly logger: PinoLogger,
    private readonly metrics: Metrics,
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

  /** Loads every area and replaces the index. */
  reload(): Promise<void> {
    return this.change(async () => {
      const startedAt = performance.now();
      const areas = await this.repository.find({ select: { id: true, geometry: true } });
      this.areas = new Map(areas.map((area) => [area.id, area]));
      this.index = AreaIndex.build([...this.areas.values()]);
      this.ready.resolve();
      this.metrics.areaIndexAreas.set(this.areas.size);
      this.metrics.areaIndexLastLoad.setToCurrentTime();
      this.logger.info(
        { areas: areas.length, durationMs: Math.round(performance.now() - startedAt) },
        'Area index loaded',
      );
    });
  }

  /**
   * Adds areas taken from `area.created` events and returns how many were new. Areas never change once
   * created, so an area already indexed (a replayed event) is left as it is.
   */
  add(areas: readonly IndexedArea[]): Promise<number> {
    return this.change(() => {
      if (!this.index) {
        // Before the first load there is nothing to add to; that load reads every area anyway.
        return Promise.resolve(0);
      }
      // One by one, so an event delivered twice in the same batch counts once.
      const added: IndexedArea[] = [];
      for (const area of areas) {
        if (!this.areas.has(area.id)) {
          this.areas.set(area.id, area);
          added.push(area);
        }
      }
      if (added.length === 0) {
        return Promise.resolve(0);
      }
      this.index = AreaIndex.build([...this.areas.values()]);
      this.metrics.areaIndexAreas.set(this.areas.size);
      this.logger.info(
        { added: added.map((area) => area.id), areas: this.areas.size },
        'Areas added to the index from events',
      );
      return Promise.resolve(added.length);
    });
  }

  /** Runs `work` after every change queued before it, whatever their outcome. */
  private change<T>(work: () => Promise<T>): Promise<T> {
    const result = this.changes.then(work, work);
    this.changes = result.catch(() => undefined);
    return result;
  }

  private async loadAndRefresh(): Promise<void> {
    const refreshMs = this.config.get('AREA_INDEX_REFRESH_MS', { infer: true });
    // Nothing can be loaded before the process has connected to the database.
    await this.database.whenConnected(this.stop.signal).catch(() => undefined);
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
