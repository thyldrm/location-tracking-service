import { type DynamicModule, Module } from '@nestjs/common';
import type { DestinationStream } from 'pino';
import type { Env } from './core/config/env.schema.js';
import { CoreModule } from './core/core.module.js';
import { SecurityModule } from './core/security/security.module.js';
import { AreasModule } from './modules/areas/areas.module.js';
import { HealthModule } from './modules/health/health.module.js';

export type RootModuleOptions = {
  /** Overrides the log destination (stdout); used by tests to capture log lines. */
  logDestination?: DestinationStream;
};

/**
 * Root module of the API role: serves the public HTTP endpoints, all protected by an API key
 * unless marked `@Public()`.
 */
@Module({})
export class ApiModule {
  static forRoot(env: Env, options: RootModuleOptions = {}): DynamicModule {
    return {
      module: ApiModule,
      imports: [
        CoreModule.forRoot(env, { role: 'api', destination: options.logDestination }),
        SecurityModule.forRoot(env),
        HealthModule,
        AreasModule,
      ],
    };
  }
}
