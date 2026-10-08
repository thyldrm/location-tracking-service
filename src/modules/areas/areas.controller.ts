import { Body, Controller, Get, Param, Post, Query, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Page } from '../../core/pagination/cursor.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { IdempotencyKey } from '../idempotency/idempotency-key.decorator.js';
import { type AreaResource, toAreaResource } from './area.resource.js';
import {
  areaIdParamsSchema,
  type CreateAreaInput,
  type ListAreasQuery,
  listAreasQuerySchema,
} from './area.schemas.js';
import { AreasService } from './areas.service.js';
import { CreateAreaValidationPipe } from './create-area-validation.pipe.js';

@Controller('areas')
export class AreasController {
  constructor(private readonly areas: AreasService) {}

  @Post()
  async create(
    @Body(CreateAreaValidationPipe) body: CreateAreaInput,
    @IdempotencyKey() idempotencyKey: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AreaResource> {
    const { area, created } = await this.areas.create(body, idempotencyKey);
    void reply.header('location', `/areas/${area.id}`);
    if (!created) {
      // Same status and body as the original response; the header tells the client it was a replay.
      void reply.header('idempotent-replayed', 'true');
    }
    return toAreaResource(area);
  }

  @Get()
  async list(
    @Query(new ZodValidationPipe(listAreasQuerySchema)) query: ListAreasQuery,
  ): Promise<Page<AreaResource>> {
    const page = await this.areas.list(query);
    return { data: page.data.map(toAreaResource), page: page.page };
  }

  @Get(':id')
  async get(
    @Param(new ZodValidationPipe(areaIdParamsSchema)) params: { id: string },
  ): Promise<AreaResource> {
    return toAreaResource(await this.areas.get(params.id));
  }
}
