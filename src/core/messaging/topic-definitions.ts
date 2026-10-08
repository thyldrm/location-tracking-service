import { type Topic, Topics } from './topics.js';

export type TopicDefinition = {
  name: Topic;
  /**
   * Upper bound on consumer parallelism (one partition is read by at most one consumer of a group).
   * Increasing it later moves keys to other partitions, which breaks per-key ordering during the change,
   * so it is sized for future load up front.
   */
  partitions: number;
  retentionMs: number;
};

const DAY_MS = 86_400_000;

/** Every topic this service owns, with the settings it is created with (SPEC.md §6). */
export const TOPIC_DEFINITIONS: readonly TopicDefinition[] = [
  { name: Topics.LocationPings, partitions: 24, retentionMs: 7 * DAY_MS },
  { name: Topics.LocationPingsDeadLetter, partitions: 3, retentionMs: 14 * DAY_MS },
  { name: Topics.AreaLifecycle, partitions: 3, retentionMs: 7 * DAY_MS },
  { name: Topics.AreaEntries, partitions: 12, retentionMs: 7 * DAY_MS },
];
