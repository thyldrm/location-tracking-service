import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager, type Repository } from 'typeorm';
import { isUniqueViolation } from '../../core/database/database-errors.js';
import { ConflictError, NotFoundError, ValidationError } from '../../core/errors/app-errors.js';
import { Clock } from '../../core/foundation/clock.js';
import { IdGenerator } from '../../core/foundation/id-generator.js';
import {
  createdAtIdCursorSchema,
  decodeCursor,
  encodeCursor,
  type Page,
} from '../../core/pagination/cursor.js';
import { hashRequest, IdempotencyStore } from '../idempotency/idempotency-store.js';
import { OutboxWriter } from '../outbox/outbox-writer.js';
import { AreaEntity } from './area.entity.js';
import { AreaGeometryValidator } from './area-geometry-validator.js';
import { areaCreatedEvent } from './area.resource.js';
import type { CreateAreaInput, ListAreasQuery } from './area.schemas.js';
import { withRfc7946Orientation } from './polygon-orientation.js';

const IDEMPOTENCY_SCOPE = 'areas.create';
const UNIQUE_NAME_INDEX = 'uq_areas_name_lower';

export type CreateAreaResult = {
  area: AreaEntity;
  /** False when an `Idempotency-Key` retry returned the area created by the original request. */
  created: boolean;
};

@Injectable()
export class AreasService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(AreaEntity) private readonly areas: Repository<AreaEntity>,
    private readonly geometryValidator: AreaGeometryValidator,
    private readonly idempotency: IdempotencyStore,
    private readonly outbox: OutboxWriter,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    @InjectPinoLogger(AreasService.name) private readonly logger: PinoLogger,
  ) {}

  /**
   * Creates an area and its `area.created` event in one transaction.
   *
   * Name uniqueness is enforced by the unique index, not by a "does it exist?" query beforehand: two
   * concurrent requests could both pass such a check (check-then-act race), the index cannot be fooled.
   */
  async create(input: CreateAreaInput, idempotencyKey?: string): Promise<CreateAreaResult> {
    const geometry = withRfc7946Orientation(input.geometry);
    const invalidityReason = await this.geometryValidator.invalidityReason(geometry);
    if (invalidityReason !== undefined) {
      throw new ValidationError('The area geometry is not a valid polygon.', [
        { path: 'geometry', message: invalidityReason },
      ]);
    }

    // Timestamps come from the application clock with millisecond precision, the precision of the
    // pagination cursor (PostgreSQL's now() has microseconds, which a JavaScript Date cannot carry).
    const now = this.clock.now();
    const area = this.areas.create({
      id: this.ids.next(),
      name: input.name,
      description: input.description,
      geometry,
      createdAt: now,
      updatedAt: now,
    });

    let result: CreateAreaResult;
    try {
      result = await this.dataSource.transaction((manager) =>
        this.createInTransaction(manager, area, input, idempotencyKey),
      );
    } catch (error) {
      if (isUniqueViolation(error, UNIQUE_NAME_INDEX)) {
        throw new ConflictError(`An area named "${input.name}" already exists.`, { cause: error });
      }
      throw error;
    }

    if (result.created) {
      this.logger.info({ areaId: result.area.id }, 'Area created');
    } else {
      this.logger.info({ areaId: result.area.id }, 'Area creation replayed (Idempotency-Key)');
    }
    return result;
  }

  private async createInTransaction(
    manager: EntityManager,
    area: AreaEntity,
    input: CreateAreaInput,
    idempotencyKey: string | undefined,
  ): Promise<CreateAreaResult> {
    // The key is claimed first: a concurrent retry then waits on the key instead of failing on the name.
    if (idempotencyKey !== undefined) {
      const claim = await this.idempotency.claim(manager, {
        scope: IDEMPOTENCY_SCOPE,
        key: idempotencyKey,
        resourceId: area.id,
        requestHash: hashRequest(input),
      });
      if (claim.status === 'replay') {
        const original = await manager.findOneByOrFail(AreaEntity, { id: claim.resourceId });
        return { area: original, created: false };
      }
    }

    await manager.insert(AreaEntity, area);
    await this.outbox.append(manager, areaCreatedEvent(area));
    return { area, created: true };
  }

  async get(id: string): Promise<AreaEntity> {
    const area = await this.areas.findOneBy({ id });
    if (!area) {
      throw new NotFoundError(`Area ${id} does not exist.`);
    }
    return area;
  }

  /** Newest first, keyset-paginated on `(created_at DESC, id DESC)`, served by `idx_areas_created_at_id`. */
  async list(query: ListAreasQuery): Promise<Page<AreaEntity>> {
    const builder = this.areas
      .createQueryBuilder('area')
      .orderBy('area.createdAt', 'DESC')
      .addOrderBy('area.id', 'DESC')
      // One extra row tells whether another page exists, without a COUNT query.
      .limit(query.limit + 1);

    if (query.cursor !== undefined) {
      const after = decodeCursor(query.cursor, createdAtIdCursorSchema);
      // Row comparison: "sorts after the last item", including ties on created_at broken by id.
      builder.where('(area.createdAt, area.id) < (:createdAt, :id)', after);
    }

    const rows = await builder.getMany();
    const items = rows.slice(0, query.limit);
    const last = items.at(-1);
    const nextCursor =
      rows.length > query.limit && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { data: items, page: { nextCursor, limit: query.limit } };
  }
}
