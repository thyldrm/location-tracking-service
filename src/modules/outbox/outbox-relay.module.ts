import { Module } from '@nestjs/common';
import { OutboxBacklogMetrics } from './outbox-backlog-metrics.js';
import { OutboxRelay } from './outbox-relay.js';

/** Worker role only: publishes the transactional outbox to Kafka (SPEC.md §9). */
@Module({
  providers: [OutboxRelay, OutboxBacklogMetrics],
})
export class OutboxRelayModule {}
