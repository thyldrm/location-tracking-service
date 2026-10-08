import { EMPTY_PRESENCE, evaluatePing, type PresenceState } from './presence-transition.js';

const TTL = 15 * 60_000;
const at = (minutes: number): Date => new Date(Date.UTC(2026, 9, 8, 12, 0) + minutes * 60_000);

function state(areaIds: string[], lastPingAt: Date | null, lastTransitionAt: Date | null = null) {
  return { areaIds, lastPingAt, lastTransitionAt } satisfies PresenceState;
}

describe('evaluatePing', () => {
  it('enters the areas of the first ping of a user', () => {
    expect(evaluatePing(EMPTY_PRESENCE, ['b', 'a'], at(0), TTL)).toEqual({
      kind: 'transition',
      entered: ['a', 'b'],
      exited: [],
      state: state(['a', 'b'], at(0), at(0)),
    });
  });

  it('records nothing while the user stays in the same areas', () => {
    expect(evaluatePing(state(['a'], at(0), at(0)), ['a'], at(1), TTL)).toEqual({
      kind: 'unchanged',
      state: state(['a'], at(1), at(0)),
    });
  });

  it('records nothing for a user outside every area', () => {
    expect(evaluatePing(EMPTY_PRESENCE, [], at(0), TTL)).toEqual({
      kind: 'unchanged',
      state: state([], at(0), null),
    });
  });

  it('exits an area at the time of the first ping outside it', () => {
    expect(evaluatePing(state(['a'], at(0), at(0)), [], at(1), TTL)).toEqual({
      kind: 'transition',
      entered: [],
      exited: [{ areaId: 'a', exitedAt: at(1) }],
      state: state([], at(1), at(1)),
    });
  });

  it('moves between overlapping areas: enters one, exits another, stays in a third', () => {
    const result = evaluatePing(state(['a', 'b'], at(0), at(0)), ['b', 'c'], at(1), TTL);

    expect(result).toMatchObject({
      kind: 'transition',
      entered: ['c'],
      exited: [{ areaId: 'a', exitedAt: at(1) }],
    });
  });

  it.each([
    ['a duplicate of the last ping', at(5)],
    ['a ping older than the last ping', at(4)],
  ])('ignores %s', (_label, timestamp) => {
    expect(evaluatePing(state(['a'], at(5), at(0)), [], timestamp, TTL)).toEqual({
      kind: 'out-of-order',
    });
  });

  it('ignores pings not newer than the last transition, even when the last ping time is unknown', () => {
    // State rebuilt from PostgreSQL after the Redis cache was lost.
    expect(evaluatePing(state(['a'], null, at(5)), [], at(5), TTL)).toEqual({
      kind: 'out-of-order',
    });
  });

  it('closes a stale session at the last ping time and counts a new entry', () => {
    const result = evaluatePing(state(['a'], at(0), at(0)), ['a'], at(16), TTL);

    expect(result).toEqual({
      kind: 'transition',
      entered: ['a'],
      exited: [{ areaId: 'a', exitedAt: at(0) }],
      state: state(['a'], at(16), at(16)),
    });
  });

  it('keeps a session alive when the gap is exactly the presence TTL', () => {
    expect(evaluatePing(state(['a'], at(0), at(0)), ['a'], at(15), TTL).kind).toBe('unchanged');
  });

  it('cannot detect a stale session when the last ping time is unknown', () => {
    // Documented degradation: only when the cached state is lost (Redis data loss).
    expect(evaluatePing(state(['a'], null, at(0)), ['a'], at(60), TTL).kind).toBe('unchanged');
  });
});
