import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { z } from 'zod';
import type { Env } from '../../core/config/env.schema.js';
import { IdGenerator } from '../../core/foundation/id-generator.js';
import { createKafka } from '../../core/messaging/kafka-client.js';
import { startConsumer } from '../../core/messaging/kafka-consumer.js';
import { Topics } from '../../core/messaging/topics.js';
import type { IndexedArea } from './area-index.js';
import { AreaIndexService } from './area-index.service.js';

const eventTypeSchema = z.object({ eventType: z.string() });

/** The part of an `area.created` envelope the index needs (SPEC.md §6). */
const areaCreatedSchema = z.object({
  eventType: z.literal('area.created'),
  payload: z.object({
    areaId: z.uuid(),
    geometry: z.object({
      type: z.literal('Polygon'),
      coordinates: z.array(z.array(z.array(z.number()).min(2)).min(4)).min(1),
    }),
  }),
});

/** Areas created by the messages of one batch; other event types and invalid messages are skipped. */
export function createdAreas(
  values: ReadonlyArray<Buffer | null>,
  onInvalid: (error: unknown) => void,
): IndexedArea[] {
  const areas: IndexedArea[] = [];
  for (const value of values) {
    try {
      const json: unknown = JSON.parse(value?.toString('utf8') ?? 'null');
      // Other event types may be added to the topic later; this consumer ignores them.
      if (eventTypeSchema.parse(json).eventType !== 'area.created') continue;
      const { payload } = areaCreatedSchema.parse(json);
      areas.push({ id: payload.areaId, geometry: payload.geometry });
    } catch (error) {
      onInvalid(error);
    }
  }
  return areas;
}

/**
 * Keeps the area index of this worker instance current: consumes `area.lifecycle.v1` and adds every
 * created area straight from its event (the event carries the geometry), so new areas are detected
 * within moments instead of at the next periodic reload.
 *
 * Every instance needs every event (broadcast, not a work queue), so each one joins a consumer group of
 * its own. The group reads the topic from the beginning on every start and never commits offsets, which
 * leaves nothing behind when the instance stops. Replaying the retained events is harmless (an area
 * already indexed is skipped) and closes the gap between the startup load of the table and the first
 * event this consumer would otherwise have seen.
 */
@Injectable()
export class AreaLifecycleConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer: KafkaJS.Consumer | undefined;
  private running: Promise<void> | undefined;
  private readonly stop = new AbortController();

  constructor(
    private readonly areaIndex: AreaIndexService,
    private readonly ids: IdGenerator,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(AreaLifecycleConsumer.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.start().catch((error: unknown) => {
      if (!this.stop.signal.aborted) {
        this.logger.error({ err: error }, 'Area lifecycle consumer stopped unexpectedly');
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.consumer?.disconnect();
    await this.running;
  }

  private async start(): Promise<void> {
    // Events are applied on top of the loaded index; the first load already contains older areas.
    await this.areaIndex.whenReady(this.stop.signal);
    const serviceName = this.config.get('SERVICE_NAME', { infer: true });
    const started = await startConsumer({
      kafka: createKafka(
        {
          KAFKA_BROKERS: this.config.get('KAFKA_BROKERS', { infer: true }),
          SERVICE_NAME: serviceName,
        },
        this.logger,
      ),
      config: {
        kafkaJS: {
          groupId: `${serviceName}.area-index.${this.ids.next()}`,
          fromBeginning: true,
          autoCommit: false,
        },
        'socket.connection.setup.timeout.ms': 3_000,
      },
      topics: [Topics.AreaLifecycle],
      run: {
        eachBatch: async ({ batch }) => {
          await this.apply(batch.messages.map((message) => message.value));
        },
      },
      signal: this.stop.signal,
      logger: this.logger,
      onCreated: (consumer) => {
        this.consumer = consumer;
      },
    });
    if (started) {
      this.logger.info('Area lifecycle consumer started');
    }
  }

  /** Never throws: a failure here must not stall the topic; the periodic reload repairs the index. */
  private async apply(values: Array<Buffer | null>): Promise<void> {
    const areas = createdAreas(values, (error) => {
      this.logger.warn({ err: error }, 'Invalid area lifecycle event skipped');
    });
    try {
      await this.areaIndex.add(areas);
    } catch (error) {
      this.logger.error({ err: error }, 'Area lifecycle events could not be applied');
    }
  }
}
