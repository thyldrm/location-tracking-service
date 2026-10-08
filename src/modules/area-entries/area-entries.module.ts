import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AreaEntriesService } from './area-entries.service.js';
import { AreaEntryEntity } from './area-entry.entity.js';
import { LogsController } from './logs.controller.js';

/** API role: `GET /logs`, the read side of the entries the worker records. */
@Module({
  imports: [TypeOrmModule.forFeature([AreaEntryEntity])],
  controllers: [LogsController],
  providers: [AreaEntriesService],
})
export class AreaEntriesModule {}
