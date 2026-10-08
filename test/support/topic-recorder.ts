import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import { createKafka } from '../../src/core/messaging/kafka-client.js';
import { testEnv } from './test-env.js';

export type RecordedMessage = {
  partition: number;
  key: string | undefined;
  value: unknown;
  headers: Record<string, string>;
};

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function headerText(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) return value.map(headerText).join(',');
  return String(value);
}

/** Records every message of a topic, so tests can assert on what the service published. */
export class TopicRecorder {
  readonly messages: RecordedMessage[] = [];

  private constructor(private readonly consumer: KafkaJS.Consumer) {}

  static async start(topic: string): Promise<TopicRecorder> {
    const consumer = createKafka(testEnv(), quietLogger).consumer({
      // A fresh group reads the topic from the beginning, independently of other tests.
      kafkaJS: { groupId: `test-recorder-${randomUUID()}`, fromBeginning: true },
    });
    const recorder = new TopicRecorder(consumer);
    await consumer.connect();
    await consumer.subscribe({ topics: [topic] });
    await consumer.run({
      eachMessage: async ({ partition, message }) => {
        recorder.messages.push({
          partition,
          key: message.key?.toString('utf8'),
          value: message.value ? JSON.parse(message.value.toString('utf8')) : undefined,
          headers: Object.fromEntries(
            Object.entries(message.headers ?? {}).map(([name, value]) => [name, headerText(value)]),
          ),
        });
      },
    });
    return recorder;
  }

  /** Waits until a recorded message satisfies `predicate`. */
  async waitFor(
    predicate: (message: RecordedMessage) => boolean,
    timeoutMs = 20_000,
  ): Promise<RecordedMessage> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate);
      if (found) return found;
      await sleep(50);
    }
    throw new Error(`No matching message within ${timeoutMs} ms`);
  }

  async stop(): Promise<void> {
    await this.consumer.disconnect();
  }
}
