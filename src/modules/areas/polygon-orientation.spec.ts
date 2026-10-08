import type { Polygon, Position } from 'geojson';
import { signedArea, withRfc7946Orientation } from './polygon-orientation.js';

const counterclockwise: Position[] = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
  [0, 0],
];
const clockwise = counterclockwise.toReversed();
const holeClockwise: Position[] = [
  [2, 2],
  [2, 4],
  [4, 4],
  [4, 2],
  [2, 2],
];

describe('signedArea', () => {
  it('is positive for counterclockwise and negative for clockwise rings', () => {
    expect(signedArea(counterclockwise)).toBe(200); // twice the area of the 10 x 10 square
    expect(signedArea(clockwise)).toBe(-200);
  });
});

describe('withRfc7946Orientation', () => {
  it('keeps a correctly oriented polygon unchanged', () => {
    const polygon: Polygon = { type: 'Polygon', coordinates: [counterclockwise, holeClockwise] };

    expect(withRfc7946Orientation(polygon)).toEqual(polygon);
  });

  it('makes the exterior ring counterclockwise and holes clockwise', () => {
    const polygon: Polygon = {
      type: 'Polygon',
      coordinates: [clockwise, holeClockwise.toReversed()],
    };

    expect(withRfc7946Orientation(polygon).coordinates).toEqual([counterclockwise, holeClockwise]);
  });

  it('does not mutate its input', () => {
    const polygon: Polygon = { type: 'Polygon', coordinates: [clockwise] };

    withRfc7946Orientation(polygon);

    expect(polygon.coordinates[0]).toEqual(clockwise);
  });
});
