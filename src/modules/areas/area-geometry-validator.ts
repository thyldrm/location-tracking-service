import { Injectable } from '@nestjs/common';
import type { Polygon } from 'geojson';
import { DataSource } from 'typeorm';
import { z } from 'zod';

const validityRows = z.array(z.object({ valid: z.boolean(), reason: z.string() })).length(1);

/**
 * Asks PostGIS whether a polygon is valid (OGC simple features rules: no self-intersection, holes
 * inside the shell, ...) and, if not, why. The `chk_areas_geometry_valid` constraint enforces the same
 * rule but can only say "violated"; checking first lets the client see the reason and the location.
 */
@Injectable()
export class AreaGeometryValidator {
  constructor(private readonly dataSource: DataSource) {}

  /** The reason the polygon is invalid, e.g. `Self-intersection[29.03 40.995]`, or `undefined`. */
  async invalidityReason(polygon: Polygon): Promise<string | undefined> {
    // Raw SQL: this evaluates PostGIS functions on a value that is not stored in any table, which
    // TypeORM has no API for. The value is passed as a bound parameter.
    const rows: unknown = await this.dataSource.query(
      `SELECT ST_IsValid(input.geometry) AS valid, ST_IsValidReason(input.geometry) AS reason
         FROM (SELECT ST_SetSRID(ST_GeomFromGeoJSON($1), 4326) AS geometry) AS input`,
      [JSON.stringify(polygon)],
    );
    const [result] = validityRows.parse(rows);
    return result && !result.valid ? result.reason : undefined;
  }
}
