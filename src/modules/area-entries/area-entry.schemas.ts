import { z } from 'zod';
import { userIdSchema } from '../locations/location.schemas.js';

// ISO 8601 with an explicit offset; in a URL, "+03:00" must be encoded as "%2B03:00" (a raw "+" means a space).
const instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value));

/** Query of `GET /logs` (SPEC.md §5.4). Strict: a misspelled filter must not widen the result. */
export const listLogsQuerySchema = z
  .strictObject({
    userId: userIdSchema.optional(),
    areaId: z.uuid().optional(),
    /** Inclusive lower bound on `enteredAt`. */
    from: instant.optional(),
    /** Exclusive upper bound on `enteredAt`. */
    to: instant.optional(),
    limit: z.coerce.number().int().min(1).max(500).default(50),
    cursor: z.string().min(1).max(512).optional(),
  })
  .refine((query) => !query.from || !query.to || query.from < query.to, {
    message: 'must be later than from',
    path: ['to'],
  });

export type ListLogsQuery = z.output<typeof listLogsQuerySchema>;

/** The filters of a query: what a cursor is only valid for. */
export type LogFilters = Pick<ListLogsQuery, 'userId' | 'areaId' | 'from' | 'to'>;
