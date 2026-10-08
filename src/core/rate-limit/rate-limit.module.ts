import { Module } from '@nestjs/common';
import { RateLimiter } from './rate-limiter.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';

@Module({
  providers: [{ provide: RateLimiter, useClass: RedisRateLimiter }],
  exports: [RateLimiter],
})
export class RateLimitModule {}
