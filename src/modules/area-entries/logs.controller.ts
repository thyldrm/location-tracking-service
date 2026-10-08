import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { DatabaseConnectedGuard } from '../../core/database/database-connection.js';
import type { Page } from '../../core/pagination/cursor.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { AreaEntriesService } from './area-entries.service.js';
import { type AreaEntryResource, toAreaEntryResource } from './area-entry.resource.js';
import { type ListLogsQuery, listLogsQuerySchema } from './area-entry.schemas.js';

// 503 until the process has connected to the database (it starts without it).
@UseGuards(DatabaseConnectedGuard)
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
