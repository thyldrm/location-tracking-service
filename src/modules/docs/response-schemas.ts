import { z } from 'zod';

/**
 * Bodies the API returns, for the OpenAPI document. They are strict: the contract test
 * (test/openapi.e2e-spec.ts) parses real responses with them, so a field added to a response without
 * being documented fails the test.
 */

const timestamp = z.iso.datetime().describe('ISO 8601, UTC');

const responsePolygon = z
  .strictObject({
    type: z.literal('Polygon'),
    coordinates: z.array(z.array(z.tuple([z.number(), z.number()]))),
  })
  .describe('GeoJSON Polygon, positions as [longitude, latitude]; exterior ring counterclockwise');

export const acceptedPingSchema = z.strictObject({
  pingId: z.uuid().describe('UUIDv7 assigned to the ping'),
  status: z.literal('accepted'),
});

export const areaSchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  geometry: responsePolygon,
  createdAt: timestamp,
});

export const areaEntrySchema = z.strictObject({
  id: z.uuid(),
  userId: z.string(),
  areaId: z.uuid(),
  enteredAt: timestamp.describe('Client time of the first ping inside the area'),
  exitedAt: timestamp
    .nullable()
    .describe('Client time of the first ping outside the area; null while the user is inside'),
  createdAt: timestamp,
});

/** One page of a keyset-paginated list (`GET /areas`, `GET /logs`). */
export function pageSchema<T extends z.ZodType>(item: T) {
  return z.strictObject({
    data: z.array(item),
    page: z.strictObject({
      nextCursor: z
        .string()
        .nullable()
        .describe('Pass as `cursor` to get the next page; null on the last page'),
      limit: z.number().int(),
    }),
  });
}

/** RFC 9457 problem document, as every error response of the service. */
export const problemSchema = z.strictObject({
  type: z.string().describe('URI identifying the problem type'),
  title: z.string(),
  status: z.number().int(),
  detail: z.string(),
  instance: z.string().optional().describe('Path of the request'),
  correlationId: z.string().optional().describe('Also returned in the x-request-id header'),
  errors: z
    .array(z.strictObject({ path: z.string(), message: z.string() }))
    .optional()
    .describe('Validation errors, one per offending field'),
});

export const livenessSchema = z.strictObject({ status: z.literal('ok') });

const dependencyStatus = z.enum(['up', 'down']);

export const readinessSchema = z.strictObject({
  status: z.enum(['ready', 'not-ready']),
  reasons: z
    .array(z.string())
    .describe('Why the process is not ready: `draining`, `area-index` (worker); empty when ready'),
  dependencies: z
    .strictObject({
      database: dependencyStatus,
      kafka: dependencyStatus,
      redis: dependencyStatus,
    })
    .describe('Reported for operators; does not decide readiness'),
});

export const metricsSchema = z.string().describe('Prometheus text exposition format');
