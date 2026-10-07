import { type DynamicModule, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Env } from '../core/config/env.schema.js';

export type ProcessRole = 'api' | 'worker';

/**
 * Creates, configures and starts a Fastify-based Nest application for one process role.
 * Both roles share this bootstrap so that probes, HTTP limits and shutdown behave identically.
 */
export async function startHttpApp(
  rootModule: DynamicModule,
  role: ProcessRole,
  env: Env,
): Promise<NestFastifyApplication> {
  const adapter = new FastifyAdapter({
    bodyLimit: env.HTTP_BODY_LIMIT_BYTES,
    trustProxy: env.HTTP_TRUST_PROXY,
  });

  const app = await NestFactory.create<NestFastifyApplication>(rootModule, adapter, {
    bufferLogs: true,
  });

  // Translates SIGTERM/SIGINT into Nest lifecycle hooks (onModuleDestroy, beforeApplicationShutdown, ...).
  app.enableShutdownHooks();

  await app.listen(env.HTTP_PORT, env.HTTP_HOST);
  new Logger('Bootstrap').log(`${role} role listening on http://${env.HTTP_HOST}:${env.HTTP_PORT}`);

  return app;
}
