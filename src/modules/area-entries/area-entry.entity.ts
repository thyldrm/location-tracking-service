import { Check, Column, Entity, Index, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { AreaEntity } from '../areas/area.entity.js';

/**
 * One visit of a user to an area: the "log" exposed by `GET /logs`.
 * Rows are append-only except for `exitedAt`, which is set once when the user leaves the area.
 */
@Entity({ name: 'area_entries' })
@Index('idx_area_entries_user_entered', { synchronize: false }) // (user_id, entered_at DESC, id DESC)
@Index('idx_area_entries_area_entered', { synchronize: false }) // (area_id, entered_at DESC, id DESC)
@Index('idx_area_entries_entered', { synchronize: false }) // (entered_at DESC, id DESC)
@Check('chk_area_entries_exit_after_entry', 'exited_at IS NULL OR exited_at >= entered_at')
export class AreaEntryEntity {
  @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'pk_area_entries' })
  id: string;

  @Column({ name: 'user_id', type: 'varchar', length: 64 })
  userId: string;

  @Column({ name: 'area_id', type: 'uuid' })
  areaId: string;

  @ManyToOne(() => AreaEntity, { nullable: false, onDelete: 'RESTRICT' })
  @JoinColumn({ name: 'area_id', foreignKeyConstraintName: 'fk_area_entries_area' })
  area?: AreaEntity;

  /** Client timestamp of the first ping observed inside the area. */
  @Column({ name: 'entered_at', type: 'timestamptz' })
  enteredAt: Date;

  /** Client timestamp of the first ping observed outside the area; null while the user is inside. */
  @Column({ name: 'exited_at', type: 'timestamptz', nullable: true })
  exitedAt: Date | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
