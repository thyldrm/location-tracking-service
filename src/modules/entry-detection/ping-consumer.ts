import { setTimeout as sleep } from 'node:timers/promises';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Env } from '../../core/config/env.schema.js';
import { backoffDelayMs, withJitter } from '../../core/foundation/backoff.js';
import { createKafka } from '../../core/messaging/kafka-client.js';
import { headersAsText, startConsumer } from '../../core/messaging/kafka-consumer.js';
import { Topics } from '../../core/messaging/topics.js';
import { AreaIndexService } from '../area-index/area-index.service.js';
import { type ConsumedMessage, PingBatchHandler } from './ping-batch-handler.js';

const BACKOFF = { baseMs: 500, maxMs: 30_000 };
/** Upper bound of messages handed to one batch handler call. */
const MAX_BATCH_SIZE = 500;

/**
 * Consumes `location.pings.v1` as a member of the `entry-detector` group: Kafka spreads the topic's
 * partitions over the worker instances (work queue), and redistributes them when an instance joins,
 * leaves or crashes (rebalance).
 *
 * Delivery is at least once:
 * - offsets are committed (periodically, by the client) only for batches the handler completed;
 * - a crash replays the uncommitted messages on whichever instance gets the partition, which the
 *   idempotent processing absorbs.
 *
 * The consumer starts only after the area index is loaded, and while a dependency is down it backs off
 * exponentially (up to 30 s) instead of redelivering the same batch in a tight loop.
 */
@Injectable()
export class PingConsumer implements OnApplicationBootstrap, OnApplicationShutdown {
  private consumer: KafkaJS.Consumer | undefined;
  private running: Promise<void> | undefined;
  private consecutiveFailures = 0;
  private readonly stop = new AbortController();

  constructor(
    private readonly handler: PingBatchHandler,
    private readonly areaIndex: AreaIndexService,
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(PingConsumer.name) private readonly logger: PinoLogger,
  ) {}

  onApplicationBootstrap(): void {
    this.running = this.start().catch((error: unknown) => {
      if (!this.stop.signal.aborted) {
        this.logger.fatal({ err: error }, 'Ping consumer stopped unexpectedly');
      }
    });
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    // Waits for the batches in progress; offsets of completed batches are committed on the way out.
    await this.consumer?.disconnect();
    await this.running;
  }

  private async start(): Promise<void> {
    await this.areaIndex.whenReady(this.stop.signal);
    const started = await startConsumer({
      kafka: createKafka(
        {
          KAFKA_BROKERS: this.config.get('KAFKA_BROKERS', { infer: true }),
          SERVICE_NAME: this.config.get('SERVICE_NAME', { infer: true }),
        },
        this.logger,
      ),
      config: {
        kafkaJS: {
          groupId: this.config.get('KAFKA_CONSUMER_GROUP', { infer: true }),
          // A new group starts at the oldest retained ping, so pings accepted before the first worker
          // started are not skipped.
          fromBeginning: true,
          autoCommit: true,
        },
        'js.consumer.max.batch.size': MAX_BATCH_SIZE,
        'socket.connection.setup.timeout.ms': 3_000,
      },
      topics: [Topics.LocationPings],
      run: {
        partitionsConsumedConcurrently: this.config.get('WORKER_PARTITION_CONCURRENCY', {
          infer: true,
        }),
        eachBatch: async (payload) => {
          const { batch } = payload;
          if (payload.isStale()) return; // the partition was revoked meanwhile; its new owner replays it
          await this.handleBatch(
            batch.messages.map((message) => ({
              topic: batch.topic,
              partition: batch.partition,
              offset: message.offset,
              key: message.key,
              value: message.value,
              headers: headersAsText(message.headers),
            })),
          );
        },
      },
      signal: this.stop.signal,
      logger: this.logger,
      onCreated: (consumer) => {
        this.consumer = consumer;
      },
    });
    if (started) {
      this.logger.info('Ping consumer started');
    }
  }

  private async handleBatch(messages: ConsumedMessage[]): Promise<void> {
    try {
      await this.handler.handle(messages);
      this.consecutiveFailures = 0;
    } catch (error) {
      this.consecutiveFailures++;
      const delayMs = backoffDelayMs(this.consecutiveFailures, BACKOFF);
      this.logger.error(
        { err: error, consecutiveFailures: this.consecutiveFailures, retryInMs: delayMs },
        'Ping batch failed; it will be redelivered',
      );
      // Jitter spreads the retries of many instances, so a recovering database is not hit all at once.
      await sleep(withJitter(delayMs), undefined, {
        signal: this.stop.signal,
      }).catch(() => undefined);
      // Rethrowing makes the client seek back to the first unprocessed message of the batch.
      throw error;
    }
  }
}
