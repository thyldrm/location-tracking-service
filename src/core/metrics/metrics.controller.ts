import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../security/public.decorator.js';
import { Metrics } from './metrics.js';

/**
 * Prometheus scrape endpoint. Public like the probes: it is reached by the monitoring system inside the
 * cluster and must not be routed through the public gateway.
 */
@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get()
  async scrape(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    void reply.header('content-type', this.metrics.registry.contentType);
    return this.metrics.registry.metrics();
  }
}
