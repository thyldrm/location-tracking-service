import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ProcessLifecycle } from '../../core/lifecycle/process-lifecycle.js';
import { AreaIndexService } from './area-index.service.js';

/** The worker is not ready before its area index is loaded: it would not consume pings yet. */
@Injectable()
export class AreaIndexReadiness implements OnModuleInit {
  constructor(
    private readonly lifecycle: ProcessLifecycle,
    private readonly areaIndex: AreaIndexService,
  ) {}

  onModuleInit(): void {
    this.lifecycle.addReadinessGate('area-index', () => this.areaIndex.isReady());
  }
}
