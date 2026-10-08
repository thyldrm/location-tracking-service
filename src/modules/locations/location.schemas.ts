import { z } from 'zod';

/** Body of `POST /locations` (SPEC.md §5.1). */
export const locationPingSchema = z.object({
  userId: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[A-Za-z0-9_-]+$/, 'must contain only letters, digits, "_" and "-"'),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  // ISO 8601 with an explicit offset ("Z" or "+03:00"): a timestamp without one is ambiguous.
  timestamp: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
  accuracy: z.number().min(0).max(100_000).optional(),
});

export type LocationPingInput = z.output<typeof locationPingSchema>;
