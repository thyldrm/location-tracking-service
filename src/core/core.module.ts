import { type DynamicModule, Module } from '@nestjs/common';
import { AppConfigModule } from './config/config.module.js';
import type { Env } from './config/env.schema.js';
import { DatabaseModule } from './database/database.module.js';

/**
 * Cross-cutting infrastructure shared by every process role (API and worker).
 * Logging, messaging and cache modules are registered here as they are introduced.
 */
@Module({})
export class CoreModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: CoreModule,
      imports: [AppConfigModule.forRoot(env), DatabaseModule.forRoot(env)],
    };
  }
}
