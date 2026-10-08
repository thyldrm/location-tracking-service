import { Module } from '@nestjs/common';
import { AreaIndexModule } from '../area-index/area-index.module.js';
import { OutboxModule } from '../outbox/outbox.module.js';
import { PingBatchHandler } from './ping-batch-handler.js';
import { PingConsumer } from './ping-consumer.js';
import { PingProcessor } from './ping-processor.js';
import { PresenceCache } from './presence-cache.js';
import { PresenceStore } from './presence-store.js';

/** Worker role: turns pings into area entries and exits (SPEC.md §8). */
@Module({
  imports: [AreaIndexModule, OutboxModule],
  providers: [PresenceCache, PresenceStore, PingProcessor, PingBatchHandler, PingConsumer],
})
export class EntryDetectionModule {}
