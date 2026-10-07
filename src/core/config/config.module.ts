import { type DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import type { Env } from './env.schema.js';

/**
 * Exposes the already validated configuration as `ConfigService<Env, true>` application-wide.
 *
 * The environment is loaded and validated once, before the Nest container is created (see `loadEnv`),
 * so the bootstrap code and every provider read exactly the same values.
 */
@Global()
@Module({})
export class AppConfigModule {
  static forRoot(env: Env): DynamicModule {
    return {
      module: AppConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          cache: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          load: [() => env],
        }),
      ],
    };
  }
}
