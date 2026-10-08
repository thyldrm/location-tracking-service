import { type DynamicModule, Global, Injectable, Module, type OnModuleInit } from '@nestjs/common';
import { HttpAdapterHost } from '@nestjs/core';
import type { FastifyInstance } from 'fastify';
import { MetricsController } from './metrics.controller.js';
import { Metrics } from './metrics.js';

/**
 * Times every HTTP request with a Fastify `onResponse` hook. A hook (rather than a Nest interceptor) also
 * sees requests that never reach a controller: unknown routes, rejected API keys, malformed bodies.
 */
@Injectable()
class HttpMetricsHook implements OnModuleInit {
  constructor(
    private readonly adapterHost: HttpAdapterHost,
    private readonly metrics: Metrics,
  ) {}

  onModuleInit(): void {
    const fastify = this.adapterHost.httpAdapter.getInstance<FastifyInstance>();
    fastify.addHook('onResponse', async (request, reply) => {
      this.metrics.httpRequestDuration.observe(
        {
          method: request.method,
          // The route template ("/areas/:id"), never the raw URL: ids would create a series per request.
          route: request.routeOptions.url ?? 'unmatched',
          status_code: String(reply.statusCode),
        },
        reply.elapsedTime / 1000,
      );
    });
  }
}

/** Provides `Metrics` to every module and serves `GET /metrics`. */
@Global()
@Module({})
export class MetricsModule {
  static forRoot(role: string): DynamicModule {
    return {
      module: MetricsModule,
      controllers: [MetricsController],
      providers: [{ provide: Metrics, useValue: new Metrics(role) }, HttpMetricsHook],
      exports: [Metrics],
    };
  }
}
