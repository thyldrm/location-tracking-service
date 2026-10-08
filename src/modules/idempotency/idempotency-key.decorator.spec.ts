import { ValidationError } from '../../core/errors/app-errors.js';
import { parseIdempotencyKey } from './idempotency-key.decorator.js';
import { hashRequest } from './idempotency-store.js';

describe('parseIdempotencyKey', () => {
  it('returns undefined when the header is absent', () => {
    expect(parseIdempotencyKey(undefined)).toBeUndefined();
  });

  it('accepts a typical client-generated key', () => {
    expect(parseIdempotencyKey('0199b1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b')).toBe(
      '0199b1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b',
    );
  });

  it.each([
    ['empty', ''],
    ['too long', 'k'.repeat(129)],
    ['containing a space', 'my key'],
    ['containing a control character', 'key\n2'],
    ['repeated', ['key-1', 'key-2']],
  ])('rejects a key that is %s', (_label, value) => {
    expect(() => parseIdempotencyKey(value)).toThrow(ValidationError);
  });
});

describe('hashRequest', () => {
  it('is stable for equal requests and differs for different ones', () => {
    expect(hashRequest({ name: 'A' })).toBe(hashRequest({ name: 'A' }));
    expect(hashRequest({ name: 'A' })).not.toBe(hashRequest({ name: 'B' }));
    expect(hashRequest({ name: 'A' })).toMatch(/^[0-9a-f]{64}$/);
  });
});
