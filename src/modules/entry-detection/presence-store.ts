import { Injectable } from '@nestjs/common';
import { DataSource, type EntityManager } from 'typeorm';
import { z } from 'zod';
import { IdGenerator } from '../../core/foundation/id-generator.js';
import { areaEnteredEvent, areaExitedEvent } from '../area-entries/area-entry-events.js';
import { AreaEntryEntity } from '../area-entries/area-entry.entity.js';
import { OutboxWriter } from '../outbox/outbox-writer.js';
import { UserAreaPresenceEntity } from '../presence/user-area-presence.entity.js';
import { UserTrackingStateEntity } from '../presence/user-tracking-state.entity.js';
import type { Exit, PresenceState } from './presence-transition.js';

export type Transitions = {
  userId: string;
  entered: string[];
  exited: Exit[];
  /** Client time of the ping that caused the transitions. */
  at: Date;
};

export type RecordedTransitions = { entries: number; exits: number };

const insertedRows = z.array(z.unknown());
const deletedPresence = z.array(z.object({ entry_id: z.string(), entered_at: z.date() }));

/**
 * The durable side of presence: PostgreSQL is the source of truth for who is inside which area.
 */
@Injectable()
export class PresenceStore {
  constructor(
    private readonly dataSource: DataSource,
    private readonly outbox: OutboxWriter,
    private readonly ids: IdGenerator,
  ) {}

  /** Rebuilds a user's state when the cache has none. The last ping time is not stored here. */
  async load(userId: string): Promise<PresenceState> {
    const [presences, tracking] = await Promise.all([
      this.dataSource.getRepository(UserAreaPresenceEntity).find({
        select: { areaId: true },
        where: { userId },
      }),
      this.dataSource.getRepository(UserTrackingStateEntity).findOne({
        select: { lastTransitionAt: true },
        where: { userId },
      }),
    ]);
    return {
      areaIds: presences.map((presence) => presence.areaId).toSorted(),
      lastPingAt: null,
      lastTransitionAt: tracking?.lastTransitionAt ?? null,
    };
  }

  /**
   * Writes the entries and exits of one ping, their events and the user's transition watermark in one
   * transaction (SPEC.md §8, step 3.7).
   *
   * Idempotent, so a redelivered ping or a stale cache cannot duplicate anything:
   * - an exit is recorded only if deleting the presence row actually deleted it;
   * - an entry is recorded only if inserting the presence row actually inserted it.
   * Exits run first, so a stale session can be closed and a new one opened in the same area.
   */
  async record(transitions: Transitions): Promise<RecordedTransitions> {
    return this.dataSource.transaction(async (manager) => {
      let exits = 0;
      for (const exit of transitions.exited) {
        if (await this.recordExit(manager, transitions.userId, exit)) exits++;
      }
      let entries = 0;
      for (const areaId of transitions.entered) {
        if (await this.recordEntry(manager, transitions.userId, areaId, transitions.at)) entries++;
      }
      await this.advanceWatermark(manager, transitions.userId, transitions.at);
      return { entries, exits };
    });
  }

  private async recordEntry(
    manager: EntityManager,
    userId: string,
    areaId: string,
    enteredAt: Date,
  ): Promise<boolean> {
    const entryId = this.ids.next();
    // The guard: the presence row is inserted first and references an entry that does not exist yet.
    // fk_user_area_presence_entry is checked at commit (DEFERRABLE INITIALLY DEFERRED).
    const inserted = await manager
      .createQueryBuilder()
      .insert()
      .into(UserAreaPresenceEntity)
      .values({ userId, areaId, entryId, enteredAt })
      .orIgnore()
      .returning('entry_id')
      .execute();
    if (insertedRows.parse(inserted.raw).length === 0) {
      return false; // already inside: a duplicate or a stale cache
    }
    await manager.insert(AreaEntryEntity, {
      id: entryId,
      userId,
      areaId,
      enteredAt,
      exitedAt: null,
    });
    await this.outbox.append(manager, areaEnteredEvent({ entryId, userId, areaId, enteredAt }));
    return true;
  }

  private async recordExit(manager: EntityManager, userId: string, exit: Exit): Promise<boolean> {
    const deleted = await manager
      .createQueryBuilder()
      .delete()
      .from(UserAreaPresenceEntity)
      .where('user_id = :userId AND area_id = :areaId', { userId, areaId: exit.areaId })
      // A string goes into RETURNING verbatim; an array would be read as entity property names and
      // silently dropped when they do not match (they are column names here).
      .returning('entry_id, entered_at')
      .execute();
    const [presence] = deletedPresence.parse(deleted.raw);
    if (!presence) {
      return false; // not inside (any more): a duplicate or a stale cache
    }
    // An exit can never precede its entry (chk_area_entries_exit_after_entry), whatever the cache said.
    const exitedAt =
      exit.exitedAt.getTime() < presence.entered_at.getTime() ? presence.entered_at : exit.exitedAt;
    await manager
      .createQueryBuilder()
      .update(AreaEntryEntity)
      .set({ exitedAt })
      .where('id = :id AND exited_at IS NULL', { id: presence.entry_id })
      .execute();
    await this.outbox.append(
      manager,
      areaExitedEvent({
        entryId: presence.entry_id,
        userId,
        areaId: exit.areaId,
        enteredAt: presence.entered_at,
        exitedAt,
      }),
    );
    return true;
  }

  /** Durable "pings older than this cannot change anything" mark; it only ever moves forward. */
  private async advanceWatermark(manager: EntityManager, userId: string, at: Date): Promise<void> {
    await manager
      .createQueryBuilder()
      .insert()
      .into(UserTrackingStateEntity)
      .values({ userId, lastTransitionAt: at })
      .orIgnore()
      .execute();
    await manager
      .createQueryBuilder()
      .update(UserTrackingStateEntity)
      .set({ lastTransitionAt: at, updatedAt: () => 'now()' })
      .where('user_id = :userId AND last_transition_at < :at', { userId, at })
      .execute();
  }
}
