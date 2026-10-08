/** What the worker knows about a user between two pings. */
export type PresenceState = {
  /** Areas the user is inside. */
  areaIds: string[];
  /** Client time of the last processed ping; `null` when the state was rebuilt from PostgreSQL. */
  lastPingAt: Date | null;
  /** Client time of the last entry or exit; `null` if the user never had one. */
  lastTransitionAt: Date | null;
};

export const EMPTY_PRESENCE: PresenceState = {
  areaIds: [],
  lastPingAt: null,
  lastTransitionAt: null,
};

export type Exit = { areaId: string; exitedAt: Date };

export type PingEvaluation =
  /** Not newer than what was already processed (duplicate delivery or out-of-order ping). */
  | { kind: 'out-of-order' }
  /** Same areas as before: only the last ping time changes. */
  | { kind: 'unchanged'; state: PresenceState }
  | { kind: 'transition'; entered: string[]; exited: Exit[]; state: PresenceState };

/**
 * Decides what one ping changes (SPEC.md §8, steps 3.3 to 3.6). A pure function: no I/O, no clock, so
 * every rule can be tested exhaustively.
 *
 * 1. A ping not newer than the last processed ping or transition is ignored. This makes processing
 *    idempotent (a redelivered ping is older than or equal to the state it produced) and keeps a late
 *    ping from undoing newer state.
 * 2. If the gap since the last ping exceeds `presenceTtlMs`, the previous session is stale: its areas are
 *    exited at the last ping time, so being inside the same area again counts as a new entry.
 * 3. Entered areas are the current ones the user was not in; exited areas the reverse.
 */
export function evaluatePing(
  previous: PresenceState,
  currentAreaIds: readonly string[],
  timestamp: Date,
  presenceTtlMs: number,
): PingEvaluation {
  const watermark = Math.max(
    previous.lastPingAt?.getTime() ?? Number.NEGATIVE_INFINITY,
    previous.lastTransitionAt?.getTime() ?? Number.NEGATIVE_INFINITY,
  );
  if (timestamp.getTime() <= watermark) {
    return { kind: 'out-of-order' };
  }

  const exited: Exit[] = [];
  let stillInside = new Set(previous.areaIds);
  const lastPingAt = previous.lastPingAt;
  if (lastPingAt && timestamp.getTime() - lastPingAt.getTime() > presenceTtlMs) {
    for (const areaId of stillInside) {
      exited.push({ areaId, exitedAt: lastPingAt });
    }
    stillInside = new Set();
  }

  const current = new Set(currentAreaIds);
  const entered = [...current].filter((areaId) => !stillInside.has(areaId)).toSorted();
  for (const areaId of [...stillInside].toSorted()) {
    if (!current.has(areaId)) {
      exited.push({ areaId, exitedAt: timestamp });
    }
  }

  const areaIds = [...current].toSorted();
  if (entered.length === 0 && exited.length === 0) {
    return {
      kind: 'unchanged',
      state: { areaIds, lastPingAt: timestamp, lastTransitionAt: previous.lastTransitionAt },
    };
  }
  return {
    kind: 'transition',
    entered,
    exited,
    state: { areaIds, lastPingAt: timestamp, lastTransitionAt: timestamp },
  };
}
