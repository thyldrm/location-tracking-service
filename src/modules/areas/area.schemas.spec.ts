import { createAreaSchema, listAreasQuerySchema } from './area.schemas.js';

const square = [
  [29.02, 40.99],
  [29.04, 40.99],
  [29.04, 41.0],
  [29.02, 41.0],
  [29.02, 40.99],
];

const validArea = {
  name: '  Kadikoy No-Parking Zone ',
  geometry: { type: 'Polygon', coordinates: [square] },
};

const schema = createAreaSchema({ maxVertices: 10 });

/** Paths of the issues reported for `input`. */
function errorPaths(input: unknown): string[] {
  const result = schema.safeParse(input);
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('createAreaSchema', () => {
  it('accepts a polygon, trims the name and defaults the description to null', () => {
    expect(schema.parse(validArea)).toEqual({
      name: 'Kadikoy No-Parking Zone',
      description: null,
      geometry: validArea.geometry,
    });
  });

  it('accepts holes', () => {
    const hole = [
      [29.025, 40.995],
      [29.025, 40.997],
      [29.027, 40.997],
      [29.027, 40.995],
      [29.025, 40.995],
    ];
    expect(
      errorPaths({ ...validArea, geometry: { type: 'Polygon', coordinates: [square, hole] } }),
    ).toEqual([]);
  });

  it.each([
    ['a blank name', { ...validArea, name: '   ' }, 'name'],
    ['a name over 120 characters', { ...validArea, name: 'n'.repeat(121) }, 'name'],
    [
      'a description over 1000 characters',
      { ...validArea, description: 'd'.repeat(1001) },
      'description',
    ],
    [
      'another geometry type',
      { ...validArea, geometry: { type: 'Point', coordinates: [29, 41] } },
      'geometry.type',
    ],
    [
      'a longitude out of range',
      {
        ...validArea,
        geometry: { type: 'Polygon', coordinates: [[[181, 40], ...square.slice(1)]] },
      },
      'geometry.coordinates.0.0.0',
    ],
    [
      'a latitude out of range',
      {
        ...validArea,
        geometry: { type: 'Polygon', coordinates: [[[29, -91], ...square.slice(1)]] },
      },
      'geometry.coordinates.0.0.1',
    ],
    [
      'an open ring',
      {
        ...validArea,
        geometry: { type: 'Polygon', coordinates: [square.slice(0, -1).concat([[29.03, 40.99]])] },
      },
      'geometry.coordinates.0',
    ],
    [
      'a ring with fewer than 4 positions',
      {
        ...validArea,
        geometry: { type: 'Polygon', coordinates: [[square[0], square[1], square[0]]] },
      },
      'geometry.coordinates.0',
    ],
    [
      'a polygon without rings',
      { ...validArea, geometry: { type: 'Polygon', coordinates: [] } },
      'geometry.coordinates',
    ],
    [
      'positions with altitude',
      {
        ...validArea,
        geometry: { type: 'Polygon', coordinates: [square.map(([lon, lat]) => [lon, lat, 10])] },
      },
      'geometry.coordinates.0.0',
    ],
    [
      'more positions than the limit',
      { ...validArea, geometry: { type: 'Polygon', coordinates: [square, square, square] } },
      'geometry.coordinates',
    ],
  ])('rejects %s', (_label, input, path) => {
    expect(errorPaths(input)).toContain(path);
  });
});

describe('listAreasQuerySchema', () => {
  it('defaults the limit and coerces query string numbers', () => {
    expect(listAreasQuerySchema.parse({})).toEqual({ limit: 50 });
    expect(listAreasQuerySchema.parse({ limit: '10', cursor: 'abc' })).toEqual({
      limit: 10,
      cursor: 'abc',
    });
  });

  it.each(['0', '201', '1.5', 'ten'])('rejects limit=%s', (limit) => {
    expect(listAreasQuerySchema.safeParse({ limit }).success).toBe(false);
  });
});
