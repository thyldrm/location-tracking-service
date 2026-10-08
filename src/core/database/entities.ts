import { AreaEntryEntity } from '../../modules/area-entries/area-entry.entity.js';
import { AreaEntity } from '../../modules/areas/area.entity.js';
import { IdempotencyKeyEntity } from '../../modules/idempotency/idempotency-key.entity.js';
import { OutboxEventEntity } from '../../modules/outbox/outbox-event.entity.js';
import { UserAreaPresenceEntity } from '../../modules/presence/user-area-presence.entity.js';
import { UserTrackingStateEntity } from '../../modules/presence/user-tracking-state.entity.js';

/** Every mapped table. Kept in one list so that the schema-drift test can compare all of them. */
export const entities = [
  AreaEntity,
  AreaEntryEntity,
  UserAreaPresenceEntity,
  UserTrackingStateEntity,
  OutboxEventEntity,
  IdempotencyKeyEntity,
];
