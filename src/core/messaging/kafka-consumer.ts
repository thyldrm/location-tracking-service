import { setTimeout as sleep } from 'node:timers/promises';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { StructuredLogger } from './kafka-client.js';
import type { Topic } from './topics.js';

const RECONNECT_DELAY_MS = 5_000;

/** Kafka header values are bytes (or lists of bytes); the service only uses UTF-8 text headers. */
export function headersAsText(headers: KafkaJS.IHeaders | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    if (value === undefined) continue;
    const first = Array.isArray(value) ? value[0] : value;
    if (first !== undefined) result[name] = first.toString();
  }
  return result;
}

export type StartConsumerOptions = {
  kafka: KafkaJS.Kafka;
  config: KafkaJS.ConsumerConstructorConfig;
  topics: Topic[];
  run: KafkaJS.ConsumerRunConfig;
  /** Aborted on shutdown: stops the retries, including the wait between them. */
  signal: AbortSignal;
  logger: StructuredLogger;
  /** Receives every consumer created, so its owner can disconnect the current one on shutdown. */
  onCreated: (consumer: KafkaJS.Consumer) => void;
};

/**
 * Connects, subscribes and runs a consumer. The cluster may be unreachable when the process starts: a
 * consumer whose start failed cannot be reused, so a new one is tried every 5 s until one runs or the
 * signal aborts. Resolves to `true` once the consumer runs, `false` if it was stopped before.
 */
export async function startConsumer(options: StartConsumerOptions): Promise<boolean> {
  const { kafka, signal, logger } = options;
  while (!signal.aborted) {
    const consumer = kafka.consumer(options.config);
    options.onCreated(consumer);
    try {
      await consumer.connect();
      await consumer.subscribe({ topics: options.topics });
      await consumer.run(options.run);
      return true;
    } catch (error) {
      if (signal.aborted) break;
      logger.error(
        { err: error, topics: options.topics },
        'Kafka consumer could not start; retrying',
      );
      await consumer.disconnect().catch(() => undefined);
      await sleep(RECONNECT_DELAY_MS, undefined, { signal }).catch(() => undefined);
    }
  }
  return false;
}
