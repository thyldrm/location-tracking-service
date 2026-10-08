import { Controller, Get, Query } from '@nestjs/common';
import type { Page } from '../../core/pagination/cursor.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { AreaEntriesService } from './area-entries.service.js';
import { type AreaEntryResource, toAreaEntryResource } from './area-entry.resource.js';
import { type ListLogsQuery, listLogsQuerySchema } from './area-entry.schemas.js';

@Controller('logs')
export class LogsController {
  constructor(private readonly entries: AreaEntriesService) {}

  @Get()
  async list(
    @Query(new ZodValidationPipe(listLogsQuerySchema)) query: ListLogsQuery,
  ): Promise<Page<AreaEntryResource>> {
    const page = await this.entries.list(query);
    return { data: page.data.map(toAreaEntryResource), page: page.page };
  }
}
