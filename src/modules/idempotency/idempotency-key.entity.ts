import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * Remembers the outcome of a request sent with an `Idempotency-Key` header so that a retried request
 * returns the original result instead of creating a duplicate.
 */
@Entity({ name: 'idempotency_keys' })
@Index('idx_idempotency_keys_created_at', ['createdAt'])
export class IdempotencyKeyEntity {
  /** Operation the key belongs to, e.g. `areas.create`. */
  @PrimaryColumn({
    type: 'varchar',
    length: 64,
    primaryKeyConstraintName: 'pk_idempotency_keys',
  })
  scope: string;

  @PrimaryColumn({
    type: 'varchar',
    length: 128,
    primaryKeyConstraintName: 'pk_idempotency_keys',
  })
  key: string;

  @Column({ name: 'resource_id', type: 'uuid' })
  resourceId: string;

  /** SHA-256 (hex) of the request body; the same key with a different body is rejected. */
  @Column({ name: 'request_hash', type: 'char', length: 64 })
  requestHash: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
