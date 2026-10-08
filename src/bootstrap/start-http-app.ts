import { type DynamicModule, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Env } from '../core/config/env.schema.js';

export type ProcessRole = 'api' | 'worker';

/**
 * Port used when `HTTP_PORT` is not set. Distinct defaults let both roles run side by side on a
 * developer machine without extra configuration; containers set `HTTP_PORT` explicitly.
 */
export const DEFAULT_HTTP_PORT: Record<ProcessRole, number> = { api: 3000, worker: 3001 };

export function resolveHttpPort(role: ProcessRole, env: Pick<Env, 'HTTP_PORT'>): number {
  return env.HTTP_PORT ?? DEFAULT_HTTP_PORT[role];
}

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

  const port = resolveHttpPort(role, env);
  await app.listen(port, env.HTTP_HOST);
  new Logger('Bootstrap').log(`${role} role listening on http://${env.HTTP_HOST}:${port}`);

  return app;
}
