import { z } from 'zod';

/** GeoJSON position: `[longitude, latitude]` (RFC 7946 §3.1.1), WGS84. Altitude is not accepted. */
const position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

/** A closed ring: at least 4 positions, the last one equal to the first (RFC 7946 §3.1.6). */
const linearRing = z
  .array(position)
  .min(4, 'A linear ring needs at least 4 positions')
  // Zod runs refinements even when `min` failed, so this must also cope with an empty ring.
  .refine(
    (ring) => {
      const first = ring[0];
      const last = ring.at(-1);
      return (
        first !== undefined && last !== undefined && first[0] === last[0] && first[1] === last[1]
      );
    },
    { message: 'A linear ring must be closed: the last position must equal the first' },
  );

/**
 * A GeoJSON `Polygon`: an exterior ring followed by optional holes. This only checks the shape of the
 * document; whether the rings form a valid polygon (no self-intersection, holes inside the shell, ...)
 * is decided by PostGIS.
 */
export function polygonSchema(maxVertices: number) {
  return z
    .object({
      type: z.literal('Polygon'),
      coordinates: z.array(linearRing).min(1, 'A polygon needs an exterior ring'),
    })
    .refine(
      (polygon) =>
        polygon.coordinates.reduce((total, ring) => total + ring.length, 0) <= maxVertices,
      { message: `A polygon may have at most ${maxVertices} positions`, path: ['coordinates'] },
    );
}

export type AreaLimits = { maxVertices: number };

export function createAreaSchema(limits: AreaLimits) {
  return z.object({
    name: z.string().trim().min(1).max(120),
    description: z
      .string()
      .max(1000)
      .nullish()
      .transform((value) => value ?? null),
    geometry: polygonSchema(limits.maxVertices),
  });
}

export type CreateAreaInput = z.output<ReturnType<typeof createAreaSchema>>;

// Strict: a misspelled parameter is an error, not silently ignored.
export const listAreasQuerySchema = z.strictObject({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(512).optional(),
});

export type ListAreasQuery = z.output<typeof listAreasQuerySchema>;

export const areaIdParamsSchema = z.object({ id: z.uuid() });
