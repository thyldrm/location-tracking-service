import { z } from 'zod';
import { ValidationError } from '../errors/app-errors.js';

/**
 * Keyset pagination cursors.
 *
 * A cursor is the sort key of the last item of a page, serialised as base64url JSON. It is opaque to
 * clients: they pass it back unchanged and must not build or parse it, so its content can change without
 * breaking them. The next page is "every row that sorts after this key", which an index answers directly,
 * unlike `OFFSET`, whose cost grows with the page number and which skips or repeats rows when data
 * changes between requests.
 */
export function encodeCursor(key: Record<string, string>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Decodes a cursor produced by `encodeCursor`; anything else is a validation error on `cursor`. */
export function decodeCursor<T>(cursor: string, schema: z.ZodType<T>): T {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    decoded = undefined;
  }
  const result = schema.safeParse(decoded);
  if (!result.success) {
    throw new ValidationError('Query parameters are invalid.', [
      {
        path: 'cursor',
        message: 'Invalid cursor; pass back the value of page.nextCursor unchanged',
      },
    ]);
  }
  return result.data;
}

/** Cursor of a list ordered by `(createdAt DESC, id DESC)`. */
export const createdAtIdCursorSchema = z.object({
  createdAt: z.iso.datetime().transform((value) => new Date(value)),
  id: z.uuid(),
});

export type CreatedAtIdCursor = z.output<typeof createdAtIdCursorSchema>;

/** One page of a keyset-paginated list. */
export type Page<T> = {
  data: T[];
  page: { nextCursor: string | null; limit: number };
};
