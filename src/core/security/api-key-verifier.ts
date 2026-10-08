import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * Checks presented API keys against the configured set without leaking information through timing.
 *
 * - Several keys may be active at once, which allows rotating a key without downtime
 *   (add the new key, move clients over, remove the old key).
 * - Keys are compared as SHA-256 digests with `timingSafeEqual`: digests always have the same length,
 *   so neither the comparison time nor a length mismatch reveals how much of a guess was correct.
 */
export class ApiKeyVerifier {
  private readonly digests: Buffer[];

  constructor(keys: readonly string[]) {
    if (keys.length === 0) {
      throw new Error('At least one API key must be configured (API_KEYS).');
    }
    this.digests = keys.map((key) => ApiKeyVerifier.digest(key));
  }

  isValid(candidate: string): boolean {
    const candidateDigest = ApiKeyVerifier.digest(candidate);
    // Compare against every key, without returning early, so timing does not reveal which key matched.
    let valid = false;
    for (const digest of this.digests) {
      valid = timingSafeEqual(digest, candidateDigest) || valid;
    }
    return valid;
  }

  private static digest(value: string): Buffer {
    return createHash('sha256').update(value, 'utf8').digest();
  }
}
