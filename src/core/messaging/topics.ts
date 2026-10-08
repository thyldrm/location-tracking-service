/**
 * Kafka topics owned by this service (SPEC.md §6). The `.v1` suffix is part of the contract: an
 * incompatible message format gets a new topic, so existing consumers keep working during a migration.
 */
export const Topics = {
  /** Raw pings, key `userId`. Produced by the API, consumed by the worker group `entry-detector`. */
  LocationPings: 'location.pings.v1',
  /** Pings that could not be processed, key `userId`. */
  LocationPingsDeadLetter: 'location.pings.v1.dlq',
  /** Area lifecycle events (`area.created`), key `areaId`. Every worker instance consumes them. */
  AreaLifecycle: 'area.lifecycle.v1',
  /** Entry and exit events (`area.entered`, `area.exited`), key `userId`. For downstream services. */
  AreaEntries: 'area.entries.v1',
} as const;

export type Topic = (typeof Topics)[keyof typeof Topics];
