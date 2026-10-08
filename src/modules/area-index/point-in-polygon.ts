import type { Polygon, Position } from 'geojson';

/** True when (x, y) lies on the segment a–b (exact arithmetic on the given coordinates). */
function onSegment(x: number, y: number, a: Position, b: Position): boolean {
  const [ax, ay] = a;
  const [bx, by] = b;
  // Collinear: the cross product of (b - a) and (p - a) is zero ...
  if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) !== 0) {
    return false;
  }
  // ... and the point lies within the segment's bounding box.
  return (
    x >= Math.min(ax, bx) && x <= Math.max(ax, bx) && y >= Math.min(ay, by) && y <= Math.max(ay, by)
  );
}

type RingRelation = 'inside' | 'boundary' | 'outside';

/**
 * Where (x, y) lies relative to a closed ring.
 *
 * Ray casting: follow a horizontal ray from the point to the right and count how many ring edges it
 * crosses; an odd count means inside. The half-open comparison `(ay > y) !== (by > y)` counts an edge
 * only if it spans the ray's height, so a ray through a vertex is counted exactly once.
 */
function relateToRing(x: number, y: number, ring: Position[]): RingRelation {
  let inside = false;
  for (let index = 0; index < ring.length - 1; index++) {
    const a = ring[index];
    const b = ring[index + 1];
    if (onSegment(x, y, a, b)) {
      return 'boundary';
    }
    const [ax, ay] = a;
    const [bx, by] = b;
    if (ay > y !== by > y) {
      // x coordinate where the edge crosses the ray's height.
      const crossingX = ax + ((y - ay) * (bx - ax)) / (by - ay);
      if (x < crossingX) {
        inside = !inside;
      }
    }
  }
  return inside ? 'inside' : 'outside';
}

/**
 * Whether the polygon covers (x, y): the point is inside the exterior ring and not strictly inside a
 * hole. Points on any ring (exterior or hole) are covered. This is PostGIS's `ST_Covers` semantics,
 * which SPEC.md §3.6 chooses: a user on the boundary of an area is inside it.
 *
 * Coordinates are treated as planar (longitude as x, latitude as y), exactly like PostGIS `geometry`.
 */
export function polygonCovers(polygon: Polygon, x: number, y: number): boolean {
  const [exterior, ...holes] = polygon.coordinates;
  if (!exterior) {
    return false;
  }
  const exteriorRelation = relateToRing(x, y, exterior);
  if (exteriorRelation !== 'inside') {
    return exteriorRelation === 'boundary';
  }
  for (const hole of holes) {
    const holeRelation = relateToRing(x, y, hole);
    if (holeRelation === 'boundary') {
      return true;
    }
    if (holeRelation === 'inside') {
      return false;
    }
  }
  return true;
}
