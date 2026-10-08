import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import type { Repository, SelectQueryBuilder } from 'typeorm';
import { z } from 'zod';
import { ValidationError } from '../../core/errors/app-errors.js';
import { decodeCursor, encodeCursor, type Page } from '../../core/pagination/cursor.js';
import { AreaEntryEntity } from './area-entry.entity.js';
import type { ListLogsQuery, LogFilters } from './area-entry.schemas.js';

/** Cursor of `GET /logs`: the sort key of the last item, and the filters it was produced for. */
const logCursorSchema = z.object({
  enteredAt: z.iso.datetime().transform((value) => new Date(value)),
  id: z.uuid(),
  filters: z.string(),
});

type LogCursor = z.output<typeof logCursorSchema>;

/**
 * A short digest of the filters. A cursor only means something together with the filters of the request
 * that produced it: replayed with other filters, it would start the new result at an arbitrary place.
 * Equal instants written differently ("Z" or "+03:00") give the same digest.
 */
export function filtersFingerprint(filters: LogFilters): string {
  const canonical = JSON.stringify([
    filters.userId ?? null,
    filters.areaId ?? null,
    filters.from?.toISOString() ?? null,
    filters.to?.toISOString() ?? null,
  ]);
  return createHash('sha256').update(canonical).digest('base64url').slice(0, 16);
}

/** Reads the area entries ("logs") for `GET /logs` (SPEC.md §5.4). */
@Injectable()
export class AreaEntriesService {
  constructor(
    @InjectRepository(AreaEntryEntity) private readonly entries: Repository<AreaEntryEntity>,
  ) {}

  /** Newest `enteredAt` first, keyset-paginated on `(entered_at DESC, id DESC)`. */
  async list(query: ListLogsQuery): Promise<Page<AreaEntryEntity>> {
    const filters = filtersFingerprint(query);
    const after = query.cursor === undefined ? undefined : decodeLogCursor(query.cursor, filters);

    const rows = await this.pageQuery(query, after).getMany();
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeCursor({ enteredAt: last.enteredAt.toISOString(), id: last.id, filters })
        : null;
    return { data: items, page: { nextCursor, limit: query.limit } };
  }

  /**
   * The query of one page. Every combination of filters is served by one of the three indexes that end in
   * `(entered_at DESC, id DESC)`, so the rows come out of the index already sorted and the scan stops after
   * `limit + 1` rows, whatever the size of the table (verified by a query plan test).
   */
  pageQuery(
    query: LogFilters & { limit: number },
    after?: Pick<LogCursor, 'enteredAt' | 'id'>,
  ): SelectQueryBuilder<AreaEntryEntity> {
    const builder = this.entries
      .createQueryBuilder('entry')
      .orderBy('entry.enteredAt', 'DESC')
      .addOrderBy('entry.id', 'DESC')
      // One extra row tells whether another page exists, without a COUNT query.
      .limit(query.limit + 1);

    if (query.userId !== undefined) {
      builder.andWhere('entry.userId = :userId', { userId: query.userId });
    }
    if (query.areaId !== undefined) {
      builder.andWhere('entry.areaId = :areaId', { areaId: query.areaId });
    }
    if (query.from !== undefined) {
      builder.andWhere('entry.enteredAt >= :from', { from: query.from });
    }
    if (query.to !== undefined) {
      builder.andWhere('entry.enteredAt < :to', { to: query.to });
    }
    if (after !== undefined) {
      // Row comparison: "sorts after the last item", ties on entered_at broken by id.
      builder.andWhere('(entry.enteredAt, entry.id) < (:afterEnteredAt, :afterId)', {
        afterEnteredAt: after.enteredAt,
        afterId: after.id,
      });
    }
    return builder;
  }
}

function decodeLogCursor(cursor: string, filters: string): LogCursor {
  const decoded = decodeCursor(cursor, logCursorSchema);
  if (decoded.filters !== filters) {
    throw new ValidationError('Query parameters are invalid.', [
      {
        path: 'cursor',
        message: 'The cursor belongs to a query with other filters; start again without a cursor',
      },
    ]);
  }
  return decoded;
}
