import type { Polygon, Position } from 'geojson';

/**
 * Twice the signed area of a ring (shoelace formula). Positive when the ring runs counterclockwise,
 * negative when clockwise, zero when it encloses no area.
 */
export function signedArea(ring: Position[]): number {
  let sum = 0;
  for (let index = 0; index < ring.length - 1; index++) {
    const [x1, y1] = ring[index];
    const [x2, y2] = ring[index + 1];
    sum += x1 * y2 - x2 * y1;
  }
  return sum;
}

/**
 * Returns the polygon with the ring orientation RFC 7946 §3.1.6 prescribes: the exterior ring
 * counterclockwise, holes clockwise. Clients send either; storing one convention means every consumer
 * of the stored or published geometry sees the same thing. A ring without area is left unchanged
 * (PostGIS rejects it as invalid).
 */
export function withRfc7946Orientation(polygon: Polygon): Polygon {
  return {
    type: 'Polygon',
    coordinates: polygon.coordinates.map((ring, index) => {
      const area = signedArea(ring);
      const shouldBeCounterclockwise = index === 0;
      const isWrong = shouldBeCounterclockwise ? area < 0 : area > 0;
      return isWrong ? ring.toReversed() : ring;
    }),
  };
}
