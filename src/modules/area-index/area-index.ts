import Flatbush from 'flatbush';
import type { Polygon } from 'geojson';
import { polygonCovers } from './point-in-polygon.js';

export type IndexedArea = { id: string; geometry: Polygon };

/**
 * Immutable in-memory spatial index of every area, answering "which areas contain this point?" without
 * a database round trip.
 *
 * Two steps, the classic filter-and-refine approach (the same one a GiST index uses in PostGIS):
 * 1. **Filter:** a packed R-tree (Flatbush) of the areas' bounding boxes finds the few candidates whose
 *    box contains the point, in O(log n).
 * 2. **Refine:** an exact point-in-polygon test on each candidate.
 *
 * Built once per refresh and then only read, so it needs no locking and can be swapped atomically.
 */
export class AreaIndex {
  private constructor(
    private readonly areas: readonly IndexedArea[],
    private readonly tree: Flatbush | undefined,
  ) {}

  static build(areas: readonly IndexedArea[]): AreaIndex {
    if (areas.length === 0) {
      // Flatbush requires at least one item.
      return new AreaIndex([], undefined);
    }
    const tree = new Flatbush(areas.length);
    for (const area of areas) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      // The exterior ring bounds the whole polygon; holes lie inside it.
      for (const [x, y] of area.geometry.coordinates[0] ?? []) {
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
      tree.add(minX, minY, maxX, maxY);
    }
    tree.finish();
    return new AreaIndex(areas, tree);
  }

  get size(): number {
    return this.areas.length;
  }

  /** Ids of the areas covering the point (boundary included), in no particular order. */
  areasContaining(longitude: number, latitude: number): string[] {
    if (!this.tree) {
      return [];
    }
    const result: string[] = [];
    for (const position of this.tree.search(longitude, latitude, longitude, latitude)) {
      const area = this.areas[position];
      if (area && polygonCovers(area.geometry, longitude, latitude)) {
        result.push(area.id);
      }
    }
    return result;
  }
}
