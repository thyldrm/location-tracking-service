import { Module } from '@nestjs/common';
import { IdempotencyModule } from '../idempotency/idempotency.module.js';
import { HousekeepingService } from './housekeeping.service.js';

/** Worker role only: deletes expired outbox events and idempotency keys. */
@Module({
  imports: [IdempotencyModule],
  providers: [HousekeepingService],
})
export class HousekeepingModule {}
