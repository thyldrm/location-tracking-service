import { backoffDelayMs, withJitter } from './backoff.js';

describe('backoffDelayMs', () => {
  const options = { baseMs: 500, maxMs: 30_000 };

  it('doubles from the base delay up to the maximum', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((failures) => backoffDelayMs(failures, options))).toEqual([
      500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000,
    ]);
  });

  it('does not wait when nothing failed', () => {
    expect(backoffDelayMs(0, options)).toBe(0);
  });
});

describe('withJitter', () => {
  it('keeps the delay between half and all of it', () => {
    expect(withJitter(1_000, () => 0)).toBe(500);
    expect(withJitter(1_000, () => 0.5)).toBe(750);
    expect(withJitter(1_000, () => 0.999_999)).toBeCloseTo(1_000);
  });
});
