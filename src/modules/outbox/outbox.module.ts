import { Module } from '@nestjs/common';
import { OutboxWriter } from './outbox-writer.js';

@Module({
  providers: [OutboxWriter],
  exports: [OutboxWriter],
})
export class OutboxModule {}
