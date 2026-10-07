import { type DynamicModule, Module } from '@nestjs/common';
import type { Env } from './core/config/env.schema.js';
import { CoreModule } from './core/core.module.js';
import { HealthModule } from './modules/health/health.module.js';

/**
 * Root module of the worker role: consumes pings, detects area entries and relays the outbox.
 * It still exposes a small HTTP server for health probes and metrics.
 */
@Module({})
export class WorkerModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: WorkerModule,
      imports: [CoreModule.forRoot(env), HealthModule],
    };
  }
}
