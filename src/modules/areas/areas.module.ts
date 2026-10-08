import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { AreaEntity } from './area.entity.js';
import { AreaGeometryValidator } from './area-geometry-validator.js';
import { AreasController } from './areas.controller.js';
import { AreasService } from './areas.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([AreaEntity]), IdempotencyModule, OutboxModule],
  controllers: [AreasController],
  providers: [AreasService, AreaGeometryValidator],
})
export class AreasModule {}
