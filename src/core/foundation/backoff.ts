export type BackoffOptions = {
  /** Delay after the first failure. */
  baseMs: number;
  /** Upper bound, reached after a few doublings. */
  maxMs: number;
};

/**
 * Exponential back-off: the delay before the next attempt after `failures` consecutive failures is
 * base, 2·base, 4·base, … capped at max (0 when nothing failed). A dependency that is down is then
 * probed rarely instead of in a tight loop, and a short glitch still recovers quickly.
 */
export function backoffDelayMs(failures: number, { baseMs, maxMs }: BackoffOptions): number {
  if (failures <= 0) {
    return 0;
  }
  return Math.min(maxMs, baseMs * 2 ** (failures - 1));
}

/**
 * Randomises a delay to between half and all of it. Instances that failed together (e.g. during a
 * database restart) then retry spread out, instead of hitting the recovering dependency all at once.
 */
export function withJitter(delayMs: number, random: () => number = Math.random): number {
  return delayMs * (0.5 + random() / 2);
}
