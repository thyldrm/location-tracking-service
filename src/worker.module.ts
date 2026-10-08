import { type DynamicModule, Module } from '@nestjs/common';
import type { RootModuleOptions } from './api.module.js';
import type { Env } from './core/config/env.schema.js';
import { CoreModule } from './core/core.module.js';
import { EntryDetectionModule } from './modules/entry-detection/entry-detection.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { HousekeepingModule } from './modules/housekeeping/housekeeping.module.js';
import { OutboxRelayModule } from './modules/outbox/outbox-relay.module.js';

/**
 * Root module of the worker role: consumes pings, detects area entries, relays the outbox and deletes
 * expired rows.
 * It still exposes a small HTTP server for health probes and metrics.
 */
@Module({})
export class WorkerModule {
  static forRoot(env: Env, options: RootModuleOptions = {}): DynamicModule {
    return {
      module: WorkerModule,
      imports: [
        CoreModule.forRoot(env, { role: 'worker', destination: options.logDestination }),
        HealthModule,
        EntryDetectionModule,
        OutboxRelayModule,
        HousekeepingModule,
      ],
    };
  }
}
