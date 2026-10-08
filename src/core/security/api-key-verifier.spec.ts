import { ApiKeyVerifier } from './api-key-verifier.js';

const CURRENT_KEY = 'current-key-0123456789abcdef0123456789';
const NEXT_KEY = 'next-key-0123456789abcdef0123456789abcd';

describe('ApiKeyVerifier', () => {
  const verifier = new ApiKeyVerifier([CURRENT_KEY, NEXT_KEY]);

  it('accepts every configured key, so keys can be rotated without downtime', () => {
    expect(verifier.isValid(CURRENT_KEY)).toBe(true);
    expect(verifier.isValid(NEXT_KEY)).toBe(true);
  });

  it.each([
    ['an unknown key', 'unknown-key-0123456789abcdef0123456789'],
    ['a prefix of a valid key', CURRENT_KEY.slice(0, 10)],
    ['a valid key with extra characters', `${CURRENT_KEY}x`],
    ['an empty string', ''],
  ])('rejects %s', (_case, candidate) => {
    expect(verifier.isValid(candidate)).toBe(false);
  });

  it('refuses to start without any key', () => {
    expect(() => new ApiKeyVerifier([])).toThrowError(/API_KEYS/);
  });
});
