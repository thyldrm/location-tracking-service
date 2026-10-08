import { createdAreas } from './area-lifecycle-consumer.js';

const AREA_ID = '01920000-0000-7000-8000-000000000001';
const geometry = {
  type: 'Polygon',
  coordinates: [
    [
      [0, 0],
      [1, 0],
      [1, 1],
      [0, 0],
    ],
  ],
};

const message = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

const areaCreated = {
  eventId: '01920000-0000-7000-8000-0000000000ff',
  eventType: 'area.created',
  schemaVersion: 1,
  payload: { areaId: AREA_ID, name: 'A', geometry },
};

describe('createdAreas', () => {
  it('takes the area id and geometry from area.created events', () => {
    expect(createdAreas([message(areaCreated)], vi.fn<(error: unknown) => void>())).toEqual([
      { id: AREA_ID, geometry },
    ]);
  });

  it('ignores other event types without reporting them', () => {
    const onInvalid = vi.fn<(error: unknown) => void>();

    expect(createdAreas([message({ eventType: 'area.renamed', payload: {} })], onInvalid)).toEqual(
      [],
    );
    expect(onInvalid).not.toHaveBeenCalled();
  });

  it('reports and skips invalid messages, keeping the valid ones', () => {
    const onInvalid = vi.fn<(error: unknown) => void>();
    const values = [
      Buffer.from('not json'),
      null,
      message({ ...areaCreated, payload: { areaId: AREA_ID, geometry: { type: 'Point' } } }),
      message(areaCreated),
    ];

    expect(createdAreas(values, onInvalid)).toEqual([{ id: AREA_ID, geometry }]);
    expect(onInvalid).toHaveBeenCalledTimes(3);
  });
});
