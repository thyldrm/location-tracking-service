import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { RequestContext } from '../../core/context/request-context.js';
import { Clock } from '../../core/foundation/clock.js';
import { IdGenerator } from '../../core/foundation/id-generator.js';
import type { Topic } from '../../core/messaging/topics.js';
import { OutboxEventEntity } from './outbox-event.entity.js';

/** A domain event as business code describes it. */
export type DomainEvent<TPayload extends object> = {
  topic: Topic;
  /** Kafka message key: events with the same key keep their order. */
  key: string;
  eventType: string;
  aggregateType: string;
  aggregateId: string;
  payload: TPayload;
  /** Version of the payload format of this event type. */
  schemaVersion?: number;
};

/** The message published to Kafka (SPEC.md §6, "Domain event envelope"). */
export type EventEnvelope<TPayload extends object> = {
  eventId: string;
  eventType: string;
  schemaVersion: number;
  occurredAt: string;
  aggregateType: string;
  aggregateId: string;
  correlationId: string;
  payload: TPayload;
};

/**
 * Writes domain events to the transactional outbox.
 *
 * An event is inserted with the caller's `EntityManager`, i.e. inside the same database transaction as
 * the state change it describes: either both are committed or neither is. Publishing to Kafka happens
 * later, in the outbox relay. This avoids the dual-write problem of "commit to the database, then
 * publish to the broker", where a crash or a broker outage between the two steps loses the event.
 */
@Injectable()
export class OutboxWriter {
  constructor(
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {}

  async append<TPayload extends object>(
    manager: EntityManager,
    event: DomainEvent<TPayload>,
  ): Promise<EventEnvelope<TPayload>> {
    if (!manager.queryRunner?.isTransactionActive) {
      throw new Error('Outbox events must be written inside the transaction of the state change');
    }

    const eventId = this.ids.next();
    const schemaVersion = event.schemaVersion ?? 1;
    // Work started outside a request (e.g. startup) has no correlation id; the event then starts its own.
    const correlationId = this.requestContext.correlationId ?? eventId;
    const envelope: EventEnvelope<TPayload> = {
      eventId,
      eventType: event.eventType,
      schemaVersion,
      occurredAt: this.clock.now().toISOString(),
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      correlationId,
      payload: event.payload,
    };

    // created_at is left to the database default (now()): one clock for every instance, so the relay's
    // (created_at, id) order does not depend on the clock skew between application servers.
    await manager.insert(OutboxEventEntity, {
      id: eventId,
      topic: event.topic,
      messageKey: event.key,
      eventType: event.eventType,
      payload: envelope,
      headers: {
        'x-request-id': correlationId,
        'content-type': 'application/json',
        'schema-version': String(schemaVersion),
      },
    });
    return envelope;
  }
}
