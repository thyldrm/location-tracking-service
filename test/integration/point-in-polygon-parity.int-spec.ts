import type { Polygon, Position } from 'geojson';
import type { DataSource } from 'typeorm';
import { polygonCovers } from '../../src/modules/area-index/point-in-polygon.js';
import { createTestDataSource } from '../support/test-env.js';

/** A concave polygon around Kadikoy with a hole, in real coordinates. */
const concaveWithHole: Polygon = {
  type: 'Polygon',
  coordinates: [
    [
      [29.02, 40.98],
      [29.06, 40.98],
      [29.06, 41.01],
      [29.045, 41.0],
      [29.04, 40.99],
      [29.035, 41.0],
      [29.02, 41.01],
      [29.02, 40.98],
    ],
    [
      [29.025, 40.985],
      [29.025, 40.99],
      [29.03, 40.99],
      [29.03, 40.985],
      [29.025, 40.985],
    ],
  ],
};

/** A deterministic pseudo-random generator, so a failure can be reproduced. */
function random(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1_103_515_245 + 12_345) % 2_147_483_648;
    return state / 2_147_483_648;
  };
}

function samplePoints(polygon: Polygon): Position[] {
  const next = random(42);
  const points: Position[] = [];
  // Random points in and around the bounding box.
  for (let index = 0; index < 3_000; index++) {
    points.push([29.015 + next() * 0.05, 40.975 + next() * 0.04]);
  }
  // Every vertex, and points on axis-aligned edges.
  for (const ring of polygon.coordinates) {
    for (let index = 0; index < ring.length - 1; index++) {
      const [ax = 0, ay = 0] = ring[index] ?? [];
      const [bx = 0, by = 0] = ring[index + 1] ?? [];
      points.push([ax, ay]);
      if (ax === bx || ay === by) {
        points.push([(ax + bx) / 2, (ay + by) / 2]);
      }
    }
  }
  return points;
}

describe('point-in-polygon parity with PostGIS ST_Covers (integration)', () => {
  let dataSource: DataSource;

  beforeAll(async () => {
    dataSource = await createTestDataSource();
  });

  afterAll(async () => {
    await dataSource.destroy();
  });

  it('agrees with PostGIS on every sampled point', async () => {
    const points = samplePoints(concaveWithHole);

    const rows: { position: string; covered: boolean }[] = await dataSource.query(
      `SELECT p.position, ST_Covers(area.geometry, ST_SetSRID(ST_MakePoint(p.x, p.y), 4326)) AS covered
         FROM unnest($2::float8[], $3::float8[]) WITH ORDINALITY AS p(x, y, position),
              (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geometry) AS area
        ORDER BY p.position`,
      [JSON.stringify(concaveWithHole), points.map(([x]) => x), points.map(([, y]) => y)],
    );

    const disagreements = rows
      .map((row, index) => {
        const [x = 0, y = 0] = points[index] ?? [];
        return { x, y, postgis: row.covered, ours: polygonCovers(concaveWithHole, x, y) };
      })
      .filter((result) => result.postgis !== result.ours);

    expect(rows).toHaveLength(points.length);
    expect(disagreements).toEqual([]);
    // The sample must exercise both answers, or the comparison proves nothing.
    expect(rows.filter((row) => row.covered).length).toBeGreaterThan(500);
    expect(rows.filter((row) => !row.covered).length).toBeGreaterThan(500);
  });
});
