import { Module } from '@nestjs/common';
import { IdempotencyStore } from './idempotency-store.js';

@Module({
  providers: [IdempotencyStore],
  exports: [IdempotencyStore],
})
export class IdempotencyModule {}
