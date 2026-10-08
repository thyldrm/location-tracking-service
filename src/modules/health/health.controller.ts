import { Controller, Get, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Public } from '../../core/security/public.decorator.js';
import { type ReadinessReport, ReadinessService } from './readiness.service.js';

@Public()
@Controller('health')
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /**
   * Liveness probe: answers as long as the event loop is responsive.
   * It deliberately checks no dependencies, so a database outage does not make the orchestrator
   * restart otherwise healthy processes.
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness probe: 200 when this process should receive traffic, 503 while it is starting (a startup
   * gate is not met) or shutting down (draining). Dependencies are reported in the body but do not make
   * the process unready: an outage they cause is shared by every instance (ADR 0010).
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) reply: FastifyReply): Promise<ReadinessReport> {
    const report = await this.readiness.report();
    void reply.status(report.status === 'ready' ? 200 : 503);
    return report;
  }
}
