/** At most `limit` events per `windowMs` for one key. */
export type RateLimitPolicy = { limit: number; windowMs: number };

export type RateLimitDecision =
  | { allowed: true }
  /** `retryAfterMs`: when the current window ends and the key may try again. */
  | { allowed: false; retryAfterMs: number };

/**
 * Counts events per key and decides whether one more is allowed. An abstraction so the algorithm and the
 * store can change, and so services can be tested without Redis.
 */
export abstract class RateLimiter {
  /** Records one event for `key` and returns whether it is within `policy`. */
  abstract consume(key: string, policy: RateLimitPolicy): Promise<RateLimitDecision>;
}
