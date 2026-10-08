import { type DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER } from '@nestjs/core';
import { AppConfigModule } from './config/config.module.js';
import type { Env } from './config/env.schema.js';
import { RequestContextModule } from './context/request-context.module.js';
import { DatabaseModule } from './database/database.module.js';
import { ProblemDetailsFilter } from './errors/problem-details.filter.js';
import { FoundationModule } from './foundation/foundation.module.js';
import { LoggingModule, type LoggingModuleOptions } from './logging/logging.module.js';
import { MessagingModule } from './messaging/messaging.module.js';
import { MetricsModule } from './metrics/metrics.module.js';
import { RedisModule } from './redis/redis.module.js';

export type CoreModuleOptions = LoggingModuleOptions;

/**
 * Cross-cutting infrastructure shared by every process role (API and worker): configuration,
 * time and id primitives, request context, structured logging, metrics, error responses, the database, the
 * Kafka producer and Redis.
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
        MetricsModule.forRoot(options.role),
        DatabaseModule.forRoot(env),
        MessagingModule,
        RedisModule,
      ],
      providers: [{ provide: APP_FILTER, useClass: ProblemDetailsFilter }],
    };
  }
}
