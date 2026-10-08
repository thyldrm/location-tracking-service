import type { Topic } from './topics.js';

/** A message ready to be published: key, serialized value and headers. */
export type OutgoingMessage = {
  /** Messages with the same key go to the same partition and keep their order. */
  key: string;
  value: string;
  headers: Record<string, string>;
};

/**
 * Why a message could not be published:
 * - `unavailable`: no connection to the cluster yet (e.g. the broker was down at startup);
 * - `queue-full`: the local send buffer is full, the broker cannot keep up (backpressure);
 * - `timeout`: the broker did not acknowledge the message within the delivery timeout;
 * - `rejected`: anything else (e.g. the broker refused the message).
 */
export type PublishFailureReason = 'unavailable' | 'queue-full' | 'timeout' | 'rejected';

export class PublishError extends Error {
  constructor(
    readonly reason: PublishFailureReason,
    options?: ErrorOptions,
  ) {
    super(`Message could not be published (${reason})`, options);
    this.name = 'PublishError';
  }
}

/**
 * Publishes messages to the message broker. Business code depends on this abstraction, not on the Kafka
 * client, so it can be replaced in tests and the client library can change without touching callers.
 */
export abstract class MessageProducer {
  /**
   * Resolves once the broker has durably stored the message (acknowledged by all in-sync replicas).
   * Rejects with a `PublishError` otherwise; the message may or may not have been stored.
   */
  abstract publish(topic: Topic, message: OutgoingMessage): Promise<void>;

  /** Whether the producer is connected and able to publish (used by readiness checks). */
  abstract isConnected(): boolean;
}
