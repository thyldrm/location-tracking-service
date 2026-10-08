/**
 * Limits how often a recurring condition is logged. A dependency that is down fails on every request or
 * message; logging each failure would flood the logs exactly when they are needed most. The condition is
 * written at most once per interval, together with the number of occurrences suppressed in between.
 */
export class ThrottledLog {
  private lastWrittenAt = Number.NEGATIVE_INFINITY;
  private suppressed = 0;

  constructor(
    private readonly intervalMs: number,
    private readonly now: () => number,
  ) {}

  /** Calls `write` (with the suppressed count) if the interval has passed; otherwise only counts. */
  record(write: (suppressedSinceLastWrite: number) => void): void {
    const now = this.now();
    if (now - this.lastWrittenAt < this.intervalMs) {
      this.suppressed++;
      return;
    }
    write(this.suppressed);
    this.lastWrittenAt = now;
    this.suppressed = 0;
  }
}
