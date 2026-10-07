import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  /**
   * Liveness probe: answers as long as the event loop is responsive.
   * It deliberately checks no dependencies, so a database outage does not make the orchestrator
   * restart otherwise healthy processes.
   */
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }
}
