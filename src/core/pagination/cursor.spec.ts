import { ValidationError } from '../errors/app-errors.js';
import { createdAtIdCursorSchema, decodeCursor, encodeCursor } from './cursor.js';

describe('keyset cursor', () => {
  const key = {
    createdAt: '2026-10-08T09:30:00.123Z',
    id: '0199b1a2-7c3d-7e4f-8a5b-6c7d8e9f0a1b',
  };

  it('round-trips the sort key of the last item', () => {
    const cursor = encodeCursor(key);

    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/); // URL-safe, needs no escaping in a query string
    expect(decodeCursor(cursor, createdAtIdCursorSchema)).toEqual({
      createdAt: new Date(key.createdAt),
      id: key.id,
    });
  });

  it.each([
    ['not base64 JSON', 'definitely-not-a-cursor'],
    ['the wrong shape', encodeCursor({ page: '2' })],
    ['an invalid id', encodeCursor({ ...key, id: '1 OR 1=1' })],
  ])('rejects %s as a validation error on cursor', (_label, cursor) => {
    let thrown: unknown;
    try {
      decodeCursor(cursor, createdAtIdCursorSchema);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as ValidationError).errors[0]?.path).toBe('cursor');
  });
});
