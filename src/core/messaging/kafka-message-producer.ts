import { setTimeout as sleep } from 'node:timers/promises';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Env } from '../config/env.schema.js';
import { createKafka, kafkaErrorCode, KafkaErrorCodes } from './kafka-client.js';
import {
  MessageProducer,
  type OutgoingMessage,
  PublishError,
  type PublishFailureReason,
} from './message-producer.js';
import type { Topic } from './topics.js';

const RECONNECT_DELAY_MS = 5_000;
const FLUSH_TIMEOUT_MS = 10_000;
const CONNECTION_SETUP_TIMEOUT_MS = 3_000;

function failureReason(error: unknown): PublishFailureReason {
  switch (kafkaErrorCode(error)) {
    case KafkaErrorCodes.ERR__QUEUE_FULL:
      return 'queue-full';
    case KafkaErrorCodes.ERR__MSG_TIMED_OUT:
    case KafkaErrorCodes.ERR__TIMED_OUT:
      return 'timeout';
    default:
      return 'rejected';
  }
}

/**
 * Kafka producer shared by the whole process (one connection, batches across requests).
 *
 * - **Durability:** idempotent producer, which implies `acks=all`: a message counts as published only once
 *   every in-sync replica has it, and broker-side retries never duplicate or reorder messages.
 * - **Startup:** the connection is established in the background, so the process starts (and serves
 *   everything that does not need Kafka) even while the cluster is unreachable. Until connected,
 *   `publish` fails fast with `unavailable`.
 * - **Backpressure:** a bounded local queue; when it is full `publish` fails immediately instead of
 *   letting memory grow, and the caller answers 503.
 * - **Shutdown:** runs after the HTTP server has stopped accepting requests, flushes what is buffered,
 *   then disconnects.
 */
@Injectable()
export class KafkaMessageProducer
  extends MessageProducer
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly kafka: KafkaJS.Kafka;
  private producer: KafkaJS.Producer | undefined;
  private connected = false;
  private connecting: Promise<void> | undefined;
  /** Aborted on shutdown: stops the reconnect loop, including its back-off sleep. */
  private readonly stop = new AbortController();

  constructor(
    private readonly config: ConfigService<Env, true>,
    @InjectPinoLogger(KafkaMessageProducer.name) private readonly logger: PinoLogger,
  ) {
    super();
    this.kafka = createKafka(
      {
        KAFKA_BROKERS: config.get('KAFKA_BROKERS', { infer: true }),
        SERVICE_NAME: config.get('SERVICE_NAME', { infer: true }),
      },
      logger,
    );
  }

  onApplicationBootstrap(): void {
    this.connecting = this.connectUntilStopped();
  }

  isConnected(): boolean {
    return this.connected;
  }

  async publish(topic: Topic, message: OutgoingMessage): Promise<void> {
    const producer = this.producer;
    if (!this.connected || !producer) {
      throw new PublishError('unavailable');
    }
    try {
      await producer.send({ topic, messages: [message] });
    } catch (error) {
      throw new PublishError(failureReason(error), { cause: error });
    }
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    const producer = this.producer;
    if (producer && this.connected) {
      try {
        await producer.flush({ timeout: FLUSH_TIMEOUT_MS });
      } catch (error) {
        this.logger.warn({ err: error }, 'Kafka producer could not flush every message');
      }
    }
    this.connected = false;
    // Also aborts a connection attempt that is still in progress.
    await producer?.disconnect();
    await this.connecting;
  }

  private async connectUntilStopped(): Promise<void> {
    while (!this.stop.signal.aborted) {
      // A producer whose connect() failed cannot be connected again: each attempt uses a new one.
      const producer = this.kafka.producer({
        'enable.idempotence': true,
        'linger.ms': this.config.get('KAFKA_LINGER_MS', { infer: true }),
        'message.timeout.ms': this.config.get('KAFKA_DELIVERY_TIMEOUT_MS', { infer: true }),
        'queue.buffering.max.messages': this.config.get('KAFKA_PRODUCER_QUEUE_MAX_MESSAGES', {
          infer: true,
        }),
        'compression.codec': 'lz4',
        // Bounds one connection attempt (TCP + authentication). disconnect() waits for an attempt in
        // progress, so this also bounds how long shutdown takes while the cluster is unreachable.
        'socket.connection.setup.timeout.ms': CONNECTION_SETUP_TIMEOUT_MS,
      });
      this.producer = producer;
      try {
        await producer.connect();
        this.connected = true;
        this.logger.info('Kafka producer connected');
        return;
      } catch (error) {
        if (this.stop.signal.aborted) {
          return;
        }
        this.logger.error({ err: error }, 'Kafka producer could not connect; retrying');
        await producer.disconnect().catch(() => undefined);
        await sleep(RECONNECT_DELAY_MS, undefined, { signal: this.stop.signal }).catch(
          () => undefined,
        );
      }
    }
  }
}
