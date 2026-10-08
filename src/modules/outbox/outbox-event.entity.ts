import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Transactional outbox. Domain events are inserted in the same transaction as the state change
 * that produced them and are published to Kafka afterwards by the outbox relay.
 */
@Entity({ name: 'outbox_events' })
@Index('idx_outbox_events_unpublished', ['createdAt', 'id'], { where: 'published_at IS NULL' })
@Index('idx_outbox_events_published_at', ['publishedAt'], { where: 'published_at IS NOT NULL' })
export class OutboxEventEntity {
  /** Equals the `eventId` of the envelope; consumers deduplicate on it. */
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_outbox_events' })
  id: string;

  /** Kafka topic names are limited to 249 characters. */
  @Column({ type: 'varchar', length: 249 })
  topic: string;

  @Column({ name: 'message_key', type: 'varchar', length: 255 })
  messageKey: string;

  @Column({ name: 'event_type', type: 'varchar', length: 100 })
  eventType: string;

  @Column({ type: 'jsonb' })
  payload: Record<string, unknown>;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  headers: Record<string, string>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'published_at', type: 'timestamptz', nullable: true })
  publishedAt: Date | null;

  @Column({ type: 'integer', default: 0 })
  attempts: number;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;
}
