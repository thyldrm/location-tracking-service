import { type DynamicModule } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { Logger } from 'nestjs-pino';
import type { Env } from '../core/config/env.schema.js';
import { ProcessLifecycle } from '../core/lifecycle/process-lifecycle.js';
import { createFastifyAdapter } from './create-fastify-adapter.js';
import { gracefulShutdown } from './graceful-shutdown.js';

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
 * Both roles share this bootstrap so that probes, HTTP limits, logging and shutdown behave identically.
 */
export async function startHttpApp(
  rootModule: DynamicModule,
  role: ProcessRole,
  env: Env,
): Promise<NestFastifyApplication> {
  const adapter = createFastifyAdapter(env);

  // Logs produced while the module graph is being built are buffered until pino is installed.
  const app = await NestFactory.create<NestFastifyApplication>(rootModule, adapter, {
    bufferLogs: true,
  });
  const logger = app.get(Logger);
  app.useLogger(logger);
  app.flushLogs();

  const port = resolveHttpPort(role, env);
  await app.listen(port, env.HTTP_HOST);
  logger.log(`${role} role listening on http://${env.HTTP_HOST}:${port}`, 'Bootstrap');

  // Instead of Nest's enableShutdownHooks, which closes at once: drain first (see gracefulShutdown).
  const shutdown = gracefulShutdown(app, app.get(ProcessLifecycle), {
    timeoutMs: env.SHUTDOWN_TIMEOUT_MS,
    logger,
    exit: (code) => process.exit(code),
  });
  // SIGTERM comes from the orchestrator, which may still route traffic to the API for a moment. The worker
  // receives no routed traffic (only probes and scrapes), so it has nothing to drain.
  const drainDelayMs = role === 'api' ? env.SHUTDOWN_DRAIN_DELAY_MS : 0;
  process.once('SIGTERM', () => void shutdown('SIGTERM', drainDelayMs));
  // Ctrl+C on a developer machine: nothing routes traffic here, close at once.
  process.once('SIGINT', () => void shutdown('SIGINT', 0));

  return app;
}
