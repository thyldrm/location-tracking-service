import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * Durable per-user ordering watermark. Written only when a transition (entry or exit) happens,
 * so it costs nothing on the common "no change" path. Pings older than `lastTransitionAt`
 * can never cause a transition, even when the Redis cache has been lost.
 */
@Entity({ name: 'user_tracking_state' })
export class UserTrackingStateEntity {
  @PrimaryColumn({
    name: 'user_id',
    type: 'varchar',
    length: 64,
    primaryKeyConstraintName: 'pk_user_tracking_state',
  })
  userId: string;

  @Column({ name: 'last_transition_at', type: 'timestamptz' })
  lastTransitionAt: Date;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;
}
