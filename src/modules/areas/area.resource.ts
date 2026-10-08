import type { Polygon } from 'geojson';
import { Topics } from '../../core/messaging/topics.js';
import type { DomainEvent } from '../outbox/outbox-writer.js';
import type { AreaEntity } from './area.entity.js';

/** An area as the HTTP API returns it (SPEC.md §5.3). */
export type AreaResource = {
  id: string;
  name: string;
  description: string | null;
  geometry: Polygon;
  createdAt: string;
};

export function toAreaResource(area: AreaEntity): AreaResource {
  return {
    id: area.id,
    name: area.name,
    description: area.description,
    geometry: area.geometry,
    createdAt: area.createdAt.toISOString(),
  };
}

export type AreaCreatedPayload = Omit<AreaResource, 'id'> & { areaId: string };

/**
 * `area.created` carries the full area, geometry included (event-carried state transfer): workers add
 * it to their in-memory index straight from the event, without a database read.
 */
export function areaCreatedEvent(area: AreaEntity): DomainEvent<AreaCreatedPayload> {
  return {
    topic: Topics.AreaLifecycle,
    key: area.id,
    eventType: 'area.created',
    aggregateType: 'area',
    aggregateId: area.id,
    payload: {
      areaId: area.id,
      name: area.name,
      description: area.description,
      geometry: area.geometry,
      createdAt: area.createdAt.toISOString(),
    },
  };
}
