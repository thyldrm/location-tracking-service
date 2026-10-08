import type { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Checks `fk_user_area_presence_entry` at commit instead of after each statement.
 *
 * Entry detection inserts the presence row first: its primary key is the idempotency guard
 * (`INSERT ... ON CONFLICT DO NOTHING RETURNING`), and only if the row was inserted is the entry it
 * references created. With an immediate check the presence row could not reference an entry that is
 * inserted later in the same transaction. Integrity is unchanged: the transaction cannot commit while
 * the reference is dangling.
 */
export class DeferPresenceEntryCheck1791460000000 implements MigrationInterface {
  name = 'DeferPresenceEntryCheck1791460000000';

  async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_area_presence ALTER CONSTRAINT fk_user_area_presence_entry DEFERRABLE INITIALLY DEFERRED`,
    );
  }

  async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE user_area_presence ALTER CONSTRAINT fk_user_area_presence_entry NOT DEFERRABLE`,
    );
  }
}
