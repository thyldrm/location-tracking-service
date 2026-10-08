import { z } from 'zod';

/** Version of the `location.pings.v1` message format, sent in the `schema-version` header. */
export const PING_SCHEMA_VERSION = 1;

/**
 * Value of a `location.pings.v1` message (SPEC.md §6). This is a contract between the API (producer) and
 * the worker (consumer): fields may be added, but not removed or changed without a new schema version.
 */
export const pingMessageSchema = z.object({
  pingId: z.string().min(1),
  userId: z.string().min(1).max(64),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  accuracy: z.number().min(0).nullable(),
  /** Client time of the sample (event time), normalised to UTC. */
  timestamp: z.iso.datetime(),
  /** Server time the API accepted the ping. */
  receivedAt: z.iso.datetime(),
});

export type PingMessage = z.infer<typeof pingMessageSchema>;
