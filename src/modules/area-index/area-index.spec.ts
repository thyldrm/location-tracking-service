import type { Polygon } from 'geojson';
import { AreaIndex } from './area-index.js';

function square(minX: number, minY: number, size: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minX, minY],
        [minX + size, minY],
        [minX + size, minY + size],
        [minX, minY + size],
        [minX, minY],
      ],
    ],
  };
}

/** A triangle whose bounding box (0..10, 0..10) is much larger than the triangle itself. */
const triangle: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [10, 0],
      [0, 10],
      [0, 0],
    ],
  ],
};

describe('AreaIndex', () => {
  it('finds every area containing the point, including overlapping ones', () => {
    const index = AreaIndex.build([
      { id: 'a', geometry: square(0, 0, 10) },
      { id: 'b', geometry: square(5, 5, 10) },
      { id: 'c', geometry: square(100, 100, 1) },
    ]);

    expect(index.areasContaining(7, 7).toSorted()).toEqual(['a', 'b']);
    expect(index.areasContaining(2, 2)).toEqual(['a']);
    expect(index.areasContaining(50, 50)).toEqual([]);
  });

  it('refines bounding-box candidates with the exact polygon', () => {
    const index = AreaIndex.build([{ id: 't', geometry: triangle }]);

    expect(index.areasContaining(2, 2)).toEqual(['t']);
    // Inside the bounding box, outside the triangle.
    expect(index.areasContaining(9, 9)).toEqual([]);
  });

  it('counts the boundary as inside', () => {
    const index = AreaIndex.build([{ id: 'a', geometry: square(0, 0, 10) }]);

    expect(index.areasContaining(10, 10)).toEqual(['a']);
  });

  it('answers an empty index', () => {
    const index = AreaIndex.build([]);

    expect(index.size).toBe(0);
    expect(index.areasContaining(0, 0)).toEqual([]);
  });
});
