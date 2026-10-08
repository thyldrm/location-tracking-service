import type { EntityManager } from 'typeorm';
import { OutboxEventEntity } from './outbox-event.entity.js';

/**
 * Deletes up to `limit` events published before `publishedBefore`, oldest first, and returns how many
 * were deleted. Unpublished events are never deleted, however old they are.
 *
 * Published rows are only kept for investigation (what was sent, when, with which correlation id); Kafka
 * itself retains the messages for the topic's retention.
 */
export async function deletePublishedOutboxEvents(
  manager: EntityManager,
  publishedBefore: Date,
  limit: number,
): Promise<number> {
  // Served by idx_outbox_events_published_at; the limit keeps each delete (and its locks) short.
  const oldest = manager
    .createQueryBuilder(OutboxEventEntity, 'event')
    .select('event.id')
    .where('event.publishedAt < :publishedBefore', { publishedBefore })
    .orderBy('event.publishedAt', 'ASC')
    .limit(limit);
  const result = await manager
    .createQueryBuilder()
    .delete()
    .from(OutboxEventEntity)
    .where(`"id" IN (${oldest.getQuery()})`)
    .setParameters(oldest.getParameters())
    .execute();
  return result.affected ?? 0;
}
