import type { Polygon } from 'geojson';
import { Check, Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * A named polygon (WGS84). The schema is owned by migrations; this class only maps it.
 */
@Entity({ name: 'areas' })
@Index('uq_areas_name_lower', { synchronize: false }) // functional index on lower(name), see migration
@Index('idx_areas_created_at_id', { synchronize: false }) // (created_at DESC, id DESC) for keyset pagination
@Index('idx_areas_geometry', ['geometry'], { spatial: true })
@Check('chk_areas_geometry_valid', 'ST_IsValid(geometry)')
@Check('chk_areas_name_not_blank', "btrim(name) <> ''")
export class AreaEntity {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_areas' })
  id: string;

  @Column({ type: 'varchar', length: 120 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ type: 'geometry', spatialFeatureType: 'Polygon', srid: 4326 })
  geometry: Polygon;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
