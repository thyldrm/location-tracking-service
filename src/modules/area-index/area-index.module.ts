import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AreaEntity } from '../areas/area.entity.js';
import { AreaIndexService } from './area-index.service.js';
import { AreaLifecycleConsumer } from './area-lifecycle-consumer.js';

@Module({
  imports: [TypeOrmModule.forFeature([AreaEntity])],
  providers: [AreaIndexService, AreaLifecycleConsumer],
  exports: [AreaIndexService],
})
export class AreaIndexModule {}
