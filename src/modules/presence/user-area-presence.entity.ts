import { Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AreaEntryEntity } from '../area-entries/area-entry.entity.js';
import { AreaEntity } from '../areas/area.entity.js';

/**
 * The areas a user is currently inside: one row per (user, area).
 *
 * The composite primary key is the idempotency guard of entry detection: an entry is only recorded
 * when inserting this row actually succeeds (`ON CONFLICT DO NOTHING RETURNING`).
 */
@Entity({ name: 'user_area_presence' })
@Index('uq_user_area_presence_entry', ['entryId'], { unique: true })
@Index('idx_user_area_presence_area', ['areaId'])
export class UserAreaPresenceEntity {
  @PrimaryColumn({
    name: 'user_id',
    type: 'varchar',
    length: 64,
    primaryKeyConstraintName: 'pk_user_area_presence',
  })
  userId: string;

  @PrimaryColumn({
    name: 'area_id',
    type: 'uuid',
    primaryKeyConstraintName: 'pk_user_area_presence',
  })
  areaId: string;

  @ManyToOne(() => AreaEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'area_id', foreignKeyConstraintName: 'fk_user_area_presence_area' })
  area?: AreaEntity;

  @Column({ name: 'entry_id', type: 'uuid' })
  entryId: string;

  @ManyToOne(() => AreaEntryEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'entry_id', foreignKeyConstraintName: 'fk_user_area_presence_entry' })
  entry?: AreaEntryEntity;

  @Column({ name: 'entered_at', type: 'timestamptz' })
  enteredAt: Date;
}
