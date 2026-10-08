import { Module } from '@nestjs/common';
import { RateLimitModule } from '../../core/rate-limit/rate-limit.module.js';
import { LocationsController } from './locations.controller.js';
import { LocationsService } from './locations.service.js';
import { PingPublishBreaker } from './ping-publish-breaker.js';

@Module({
  imports: [RateLimitModule],
  controllers: [LocationsController],
  providers: [LocationsService, PingPublishBreaker],
})
export class LocationsModule {}
