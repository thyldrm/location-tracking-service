export type CircuitState = 'closed' | 'open' | 'half-open';

export type CircuitBreakerOptions = {
  /** Consecutive failures that open the circuit. */
  failureThreshold: number;
  /** How long an open circuit rejects calls before it lets one trial call through. */
  openDurationMs: number;
  /** Whether an error means "the dependency is down". Other errors pass through and count as success. */
  isFailure: (error: unknown) => boolean;
  /** Current time in milliseconds. */
  now: () => number;
  onStateChange?: (state: CircuitState, previous: CircuitState) => void;
};

/** Thrown instead of calling a dependency that is known to be down. */
export class CircuitOpenError extends Error {
  constructor(readonly retryAfterMs: number) {
    super('Circuit open: the dependency is considered unavailable');
    this.name = 'CircuitOpenError';
  }
}

/**
 * Circuit breaker: stops calling a dependency that keeps failing, so callers fail at once instead of each
 * waiting for its own timeout.
 *
 * - **closed:** calls go through. `failureThreshold` consecutive failures open the circuit.
 * - **open:** calls are rejected with `CircuitOpenError` without touching the dependency, for
 *   `openDurationMs`.
 * - **half-open:** after that, exactly one trial call goes through (the others are still rejected). Its
 *   success closes the circuit, its failure opens it again for another `openDurationMs`.
 *
 * Only the trial decides whether an open circuit closes. Calls admitted while the circuit was still closed
 * may finish after it opened; their late successes or failures do not change its state.
 */
export class CircuitBreaker {
  private current: CircuitState = 'closed';
  private consecutiveFailures = 0;
  private openedAt = 0;
  private trialInFlight = false;

  constructor(private readonly options: CircuitBreakerOptions) {}

  get state(): CircuitState {
    return this.current;
  }

  async execute<T>(work: () => Promise<T>): Promise<T> {
    const isTrial = this.admit();
    try {
      const result = await work();
      this.recordSuccess(isTrial);
      return result;
    } catch (error) {
      if (this.options.isFailure(error)) {
        this.recordFailure(isTrial);
      } else {
        this.recordSuccess(isTrial);
      }
      throw error;
    }
  }

  /** Lets a call through or throws `CircuitOpenError`; returns whether the call is the trial. */
  private admit(): boolean {
    if (this.current === 'open') {
      const remainingMs = this.openedAt + this.options.openDurationMs - this.options.now();
      if (remainingMs > 0) {
        throw new CircuitOpenError(remainingMs);
      }
      this.transition('half-open');
    }
    if (this.current === 'half-open') {
      if (this.trialInFlight) {
        throw new CircuitOpenError(this.options.openDurationMs);
      }
      this.trialInFlight = true;
      return true;
    }
    return false;
  }

  private recordSuccess(isTrial: boolean): void {
    if (isTrial) {
      this.trialInFlight = false;
      this.consecutiveFailures = 0;
      this.transition('closed');
    } else if (this.current === 'closed') {
      this.consecutiveFailures = 0;
    }
  }

  private recordFailure(isTrial: boolean): void {
    if (isTrial) {
      this.trialInFlight = false;
      this.open();
    } else if (this.current === 'closed') {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= this.options.failureThreshold) {
        this.open();
      }
    }
  }

  private open(): void {
    this.openedAt = this.options.now();
    this.transition('open');
  }

  private transition(state: CircuitState): void {
    const previous = this.current;
    if (previous === state) return;
    this.current = state;
    this.options.onStateChange?.(state, previous);
  }
}
