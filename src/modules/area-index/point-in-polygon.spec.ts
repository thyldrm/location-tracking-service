import type { Polygon } from 'geojson';
import { polygonCovers } from './point-in-polygon.js';

/** 10 x 10 square with a 2 x 2 hole in the middle. */
const squareWithHole: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
      [0, 0],
    ],
    [
      [4, 4],
      [4, 6],
      [6, 6],
      [6, 4],
      [4, 4],
    ],
  ],
};

/** A concave "U": the notch between the arms (x 3..7, y 3..10) is outside. */
const uShape: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [10, 10],
      [7, 10],
      [7, 3],
      [3, 3],
      [3, 10],
      [0, 10],
      [0, 0],
    ],
  ],
};

describe('polygonCovers', () => {
  it.each([
    ['inside', 2, 2, true],
    ['outside', 11, 5, false],
    ['inside the hole', 5, 5, false],
    ['on an exterior edge', 10, 5, true],
    ['on an exterior vertex', 0, 0, true],
    ['on the hole boundary', 4, 5, true],
    ['on a hole vertex', 6, 6, true],
    ['level with a vertex but outside', -1, 0, false],
    ['level with a vertex and inside', 5, 10 - 1e-9, true],
  ])('a point %s', (_label, x, y, expected) => {
    expect(polygonCovers(squareWithHole, x, y)).toBe(expected);
  });

  it.each([
    ['in the left arm', 1, 8, true],
    ['in the notch of a concave polygon', 5, 8, false],
    ['on the inner corner of the notch', 3, 3, true],
    ['at the height of the notch floor, inside', 8, 3, true],
  ])('a point %s', (_label, x, y, expected) => {
    expect(polygonCovers(uShape, x, y)).toBe(expected);
  });

  it('works with either ring orientation', () => {
    const clockwise: Polygon = {
      type: 'Polygon',
      coordinates: [(squareWithHole.coordinates[0] ?? []).toReversed()],
    };

    expect(polygonCovers(clockwise, 2, 2)).toBe(true);
    expect(polygonCovers(clockwise, 12, 2)).toBe(false);
  });
});
