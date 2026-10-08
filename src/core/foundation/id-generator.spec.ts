import { validate, version } from 'uuid';
import { UuidV7Generator } from './id-generator.js';

describe('UuidV7Generator', () => {
  const generator = new UuidV7Generator();

  it('generates valid version 7 UUIDs', () => {
    const id = generator.next();

    expect(validate(id)).toBe(true);
    expect(version(id)).toBe(7);
  });

  it('generates ids that sort in creation order', () => {
    const ids = Array.from({ length: 1_000 }, () => generator.next());

    expect(ids.toSorted()).toEqual(ids);
  });
});
