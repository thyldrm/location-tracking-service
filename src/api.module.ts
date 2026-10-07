import { type DynamicModule, Module } from '@nestjs/common';
import type { Env } from './core/config/env.schema.js';
import { CoreModule } from './core/core.module.js';
import { HealthModule } from './modules/health/health.module.js';

/**
 * Root module of the API role: serves the public HTTP endpoints.
 */
@Module({})
export class ApiModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: ApiModule,
      imports: [CoreModule.forRoot(env), HealthModule],
    };
  }
}
