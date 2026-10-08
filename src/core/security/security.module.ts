import { type DynamicModule, Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { Env } from '../config/env.schema.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeyVerifier } from './api-key-verifier.js';

/**
 * Protects every route of the role that imports it. Only the API role does: the worker exposes
 * nothing but health and metrics endpoints.
 */
@Module({})
export class SecurityModule {
  static forRoot(env: Pick<Env, 'API_KEYS'>): DynamicModule {
    return {
      module: SecurityModule,
      providers: [
        // Constructed eagerly: an API role without keys fails at startup, not at the first request.
        { provide: ApiKeyVerifier, useValue: new ApiKeyVerifier(env.API_KEYS) },
        { provide: APP_GUARD, useClass: ApiKeyGuard },
      ],
    };
  }
}
