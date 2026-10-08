import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Env } from '../../core/config/env.schema.js';
import { RequestContext } from '../../core/context/request-context.js';
import { isTransientError } from '../../core/errors/transient-errors.js';
import { Clock } from '../../core/foundation/clock.js';
import { MessageProducer } from '../../core/messaging/message-producer.js';
import { Topics } from '../../core/messaging/topics.js';
import { Metrics } from '../../core/metrics/metrics.js';
import {
  PING_SCHEMA_VERSION,
  type PingMessage,
  pingMessageSchema,
} from '../locations/ping-message.js';
import { PingProcessor } from './ping-processor.js';

/** A message as consumed from Kafka, independent of the client library. */
export type ConsumedMessage = {
  topic: string;
  partition: number;
  offset: string;
  key: Buffer | null;
  value: Buffer | null;
  headers: Record<string, string>;
};

type DecodedPing = { message: ConsumedMessage; ping: PingMessage };

const RETRY_BASE_DELAY_MS = 100;
const MAX_ERROR_HEADER_LENGTH = 500;

function errorText(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return text.slice(0, MAX_ERROR_HEADER_LENGTH);
}

/**
 * Processes one batch of pings from one partition (SPEC.md §8).
 *
 * Failure handling, by kind of failure:
 * - **Invalid message** (not JSON, wrong shape, unknown schema version): it will never succeed, so it goes
 *   to the dead letter topic immediately and the batch continues. One bad message never blocks a
 *   partition.
 * - **Transient error** (database or network unavailable): the error is rethrown. The consumer backs off
 *   and the batch is redelivered from the first unprocessed offset; offsets are not committed, so nothing
 *   is lost and consumer lag grows until the dependency is back.
 * - **Any other error** (e.g. a bug triggered by one ping): retried a few times in place; if it keeps
 *   failing, the ping goes to the dead letter topic with the error in its headers, and the batch goes on.
 *
 * Users are processed concurrently, but the pings of one user strictly one after another and in order.
 */
@Injectable()
export class PingBatchHandler {
  private readonly maxAttempts: number;

  constructor(
    private readonly processor: PingProcessor,
    private readonly producer: MessageProducer,
    private readonly requestContext: RequestContext,
    config: ConfigService<Env, true>,
    @InjectPinoLogger(PingBatchHandler.name) private readonly logger: PinoLogger,
    private readonly clock: Clock,
    private readonly metrics: Metrics,
  ) {
    this.maxAttempts = config.get('WORKER_MAX_ATTEMPTS', { infer: true });
  }

  async handle(messages: readonly ConsumedMessage[]): Promise<void> {
    const byUser = new Map<string, DecodedPing[]>();
    for (const message of messages) {
      const decoded = this.decode(message);
      if (typeof decoded === 'string') {
        await this.deadLetter(message, 'invalid-message', decoded, 0);
        continue;
      }
      const pings = byUser.get(decoded.ping.userId) ?? [];
      pings.push(decoded);
      byUser.set(decoded.ping.userId, pings);
    }

    // allSettled, not all: on a transient failure every other user must finish (or fail) before the batch
    // is redelivered, otherwise the redelivered batch could run concurrently with the unfinished work.
    const results = await Promise.allSettled(
      [...byUser.values()].map((pings) => this.processUser(pings)),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) {
      throw failure.reason;
    }
  }

  private async processUser(pings: readonly DecodedPing[]): Promise<void> {
    for (const decoded of pings) {
      await this.processWithRetries(decoded);
    }
  }

  private async processWithRetries({ message, ping }: DecodedPing): Promise<void> {
    const correlationId = message.headers['x-request-id'] ?? ping.pingId;
    for (let attempt = 1; ; attempt++) {
      try {
        // The ping's correlation id (from the API request) follows it into logs and outbox events.
        const outcome = await this.requestContext.run(correlationId, () =>
          this.processor.process(ping),
        );
        this.metrics.pingsProcessed.inc({ outcome });
        // Freshness as the user experiences it: from the API accepting the ping to its processing.
        this.metrics.pingProcessingDelay.observe(
          (this.clock.now().getTime() - Date.parse(ping.receivedAt)) / 1000,
        );
        return;
      } catch (error) {
        if (isTransientError(error)) {
          throw error;
        }
        if (attempt >= this.maxAttempts) {
          await this.deadLetter(message, 'processing-failed', errorText(error), attempt);
          return;
        }
        this.logger.warn(
          { err: error, attempt, partition: message.partition, offset: message.offset },
          'Ping processing failed; retrying',
        );
        await sleep(RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
      }
    }
  }

  /** The decoded ping, or the reason it cannot be processed. */
  private decode(message: ConsumedMessage): DecodedPing | string {
    const version = message.headers['schema-version'];
    if (version !== String(PING_SCHEMA_VERSION)) {
      return `Unsupported schema-version "${version ?? ''}"`;
    }
    let json: unknown;
    try {
      json = JSON.parse(message.value?.toString('utf8') ?? '');
    } catch {
      return 'Value is not valid JSON';
    }
    const parsed = pingMessageSchema.safeParse(json);
    if (!parsed.success) {
      return parsed.error.issues
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; ')
        .slice(0, MAX_ERROR_HEADER_LENGTH);
    }
    return { message, ping: parsed.data };
  }

  /**
   * Forwards the original message unchanged (key, value, headers) with the reason in extra headers, so an
   * operator can inspect it and, after a fix, replay it to the original topic.
   */
  private async deadLetter(
    message: ConsumedMessage,
    reason: string,
    error: string,
    attempts: number,
  ): Promise<void> {
    await this.producer.publish(Topics.LocationPingsDeadLetter, {
      key: message.key?.toString('utf8') ?? null,
      value: message.value ?? '',
      headers: {
        ...message.headers,
        'x-dlq-reason': reason,
        'x-dlq-error': error,
        'x-dlq-attempts': String(attempts),
        'x-original-topic': message.topic,
        'x-original-partition': String(message.partition),
        'x-original-offset': message.offset,
      },
    });
    this.metrics.pingsDeadLettered.inc({ reason });
    this.logger.error(
      { reason, error, partition: message.partition, offset: message.offset },
      'Ping sent to the dead letter topic',
    );
  }
}
