import type { ConfigService } from '@nestjs/config';
import type { Polygon } from 'geojson';
import type { PinoLogger } from 'nestjs-pino';
import type { Repository } from 'typeorm';
import type { Env } from '../../core/config/env.schema.js';
import type { AreaEntity } from '../areas/area.entity.js';
import type { IndexedArea } from './area-index.js';
import { AreaIndexService } from './area-index.service.js';

function square(minX: number, minY: number): Polygon {
  return {
    type: 'Polygon',
    coordinates: [
      [
        [minX, minY],
        [minX + 1, minY],
        [minX + 1, minY + 1],
        [minX, minY + 1],
        [minX, minY],
      ],
    ],
  };
}

const OLD: IndexedArea = { id: 'old', geometry: square(0, 0) };
const NEW: IndexedArea = { id: 'new', geometry: square(10, 10) };

const silentLogger = {
  info: vi.fn<() => void>(),
  error: vi.fn<() => void>(),
} as unknown as PinoLogger;
const config = { get: () => 60_000 } as unknown as ConfigService<Env, true>;

/** A table whose reads complete only when the test says so. */
function controlledTable() {
  const reads: Array<PromiseWithResolvers<IndexedArea[]>> = [];
  const repository = {
    find: () => {
      const read = Promise.withResolvers<IndexedArea[]>();
      reads.push(read);
      return read.promise;
    },
  } as unknown as Repository<AreaEntity>;
  /** The `index`-th read, once it has started (changes run one after another, asynchronously). */
  const read = async (index: number): Promise<PromiseWithResolvers<IndexedArea[]>> =>
    vi.waitFor(() => {
      const started = reads[index];
      if (!started) throw new Error(`read ${index} has not started`);
      return started;
    });
  return { repository, reads, read };
}

async function loadedService(areas: IndexedArea[]) {
  const table = controlledTable();
  const service = new AreaIndexService(table.repository, config, silentLogger);
  const loading = service.reload();
  (await table.read(0)).resolve(areas);
  await loading;
  return { service, table };
}

describe('AreaIndexService', () => {
  it('adds a created area to the index without reading the table', async () => {
    const { service, table } = await loadedService([OLD]);

    expect(await service.add([NEW])).toBe(1);

    expect(service.areasContaining(10.5, 10.5)).toEqual(['new']);
    expect(service.areasContaining(0.5, 0.5)).toEqual(['old']);
    expect(table.reads).toHaveLength(1);
  });

  it('skips areas that are already indexed (a replayed event)', async () => {
    const { service } = await loadedService([OLD]);

    expect(await service.add([OLD])).toBe(0);
    await service.add([NEW]);
    expect(await service.add([NEW])).toBe(0);
  });

  it('does not lose an area added while a reload that missed it is still running', async () => {
    const { service, table } = await loadedService([OLD]);

    // The reload reads the table just before the new area is committed ...
    const reloading = service.reload();
    // ... and the area's event arrives while that reload is still in progress.
    const adding = service.add([NEW]);
    (await table.read(1)).resolve([OLD]);
    await Promise.all([reloading, adding]);

    expect(service.areasContaining(10.5, 10.5)).toEqual(['new']);
  });

  it('keeps applying changes after a failed reload', async () => {
    const { service, table } = await loadedService([OLD]);

    const failing = service.reload();
    (await table.read(1)).reject(new Error('database down'));
    await expect(failing).rejects.toThrow('database down');

    expect(await service.add([NEW])).toBe(1);
    expect(service.areasContaining(0.5, 0.5)).toEqual(['old']);
  });

  it('ignores events before the first load, which reads every area anyway', async () => {
    const table = controlledTable();
    const service = new AreaIndexService(table.repository, config, silentLogger);

    expect(await service.add([NEW])).toBe(0);
    expect(service.isReady()).toBe(false);
  });
});
