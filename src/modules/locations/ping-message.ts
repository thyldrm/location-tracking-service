/** Version of the `location.pings.v1` message format, sent in the `schema-version` header. */
export const PING_SCHEMA_VERSION = 1;

/**
 * Value of a `location.pings.v1` message (SPEC.md §6). This is a contract with the worker: fields may be
 * added, but not removed or changed without a new schema version.
 */
export type PingMessage = {
  pingId: string;
  userId: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  /** Client time of the sample (event time), normalised to UTC. */
  timestamp: string;
  /** Server time the API accepted the ping. */
  receivedAt: string;
};
