import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/config.module.js';
import type { Env } from './config/env.schema.js';
import { RequestContextModule } from './context/request-context.module.js';
import { DatabaseModule } from './database/database.module.js';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { FoundationModule } from './foundation/foundation.module.js';
import { LoggingModule, type LoggingModuleOptions } from './logging/logging.module.js';

export type CoreModuleOptions = LoggingModuleOptions;

/**
 * Cross-cutting infrastructure shared by every process role (API and worker): configuration,
 * time and id primitives, request context, structured logging, error responses and the database.
 * Messaging and cache modules are registered here as they are introduced.
 */
@Module({})
export class CoreModule {
  static forRoot(env: Env, options: CoreModuleOptions): DynamicModule {
    return {
      module: CoreModule,
      imports: [
        AppConfigModule.forRoot(env),
        FoundationModule,
        RequestContextModule,
        LoggingModule.forRoot(env, options),
        DatabaseModule.forRoot(env),
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
