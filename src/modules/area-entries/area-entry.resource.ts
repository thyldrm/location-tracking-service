import type { AreaEntryEntity } from './area-entry.entity.js';

/** One log item as `GET /logs` returns it (SPEC.md §5.4). */
export type AreaEntryResource = {
  id: string;
  userId: string;
  areaId: string;
  enteredAt: string;
  exitedAt: string | null;
  createdAt: string;
};

export function toAreaEntryResource(entry: AreaEntryEntity): AreaEntryResource {
  return {
    id: entry.id,
    userId: entry.userId,
    areaId: entry.areaId,
    enteredAt: entry.enteredAt.toISOString(),
    exitedAt: entry.exitedAt?.toISOString() ?? null,
    createdAt: entry.createdAt.toISOString(),
  };
}
