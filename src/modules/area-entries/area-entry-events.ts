import { Topics } from '../../core/messaging/topics.js';
import type { DomainEvent } from '../outbox/outbox-writer.js';

export type AreaEnteredPayload = {
  entryId: string;
  userId: string;
  areaId: string;
  enteredAt: string;
};

export type AreaExitedPayload = AreaEnteredPayload & { exitedAt: string };

/**
 * Entry events are keyed by user id: all events of a user keep their order for consumers, the same
 * ordering the pings had.
 */
export function areaEnteredEvent(entry: {
  entryId: string;
  userId: string;
  areaId: string;
  enteredAt: Date;
}): DomainEvent<AreaEnteredPayload> {
  return {
    topic: Topics.AreaEntries,
    key: entry.userId,
    eventType: 'area.entered',
    aggregateType: 'user',
    aggregateId: entry.userId,
    payload: {
      entryId: entry.entryId,
      userId: entry.userId,
      areaId: entry.areaId,
      enteredAt: entry.enteredAt.toISOString(),
    },
  };
}

export function areaExitedEvent(exit: {
  entryId: string;
  userId: string;
  areaId: string;
  enteredAt: Date;
  exitedAt: Date;
}): DomainEvent<AreaExitedPayload> {
  return {
    topic: Topics.AreaEntries,
    key: exit.userId,
    eventType: 'area.exited',
    aggregateType: 'user',
    aggregateId: exit.userId,
    payload: {
      entryId: exit.entryId,
      userId: exit.userId,
      areaId: exit.areaId,
      enteredAt: exit.enteredAt.toISOString(),
      exitedAt: exit.exitedAt.toISOString(),
    },
  };
}
