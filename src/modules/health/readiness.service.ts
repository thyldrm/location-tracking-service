import { setTimeout as sleep } from 'node:timers/promises';
import { Injectable } from '@nestjs/common';
import { Redis } from 'ioredis';
import { DataSource } from 'typeorm';
import { ProcessLifecycle } from '../../core/lifecycle/process-lifecycle.js';
import { MessageProducer } from '../../core/messaging/message-producer.js';

/** Probes time out after about a second; a dependency check must answer well within that. */
const DEPENDENCY_CHECK_TIMEOUT_MS = 500;

export type DependencyStatus = 'up' | 'down';

export type ReadinessReport = {
  status: 'ready' | 'not-ready';
  /** Why the process is not ready (`draining`, an unmet startup gate); empty when ready. */
  reasons: string[];
  /** Reported for operators; not part of the decision (see ProcessLifecycle). */
  dependencies: { database: DependencyStatus; kafka: DependencyStatus; redis: DependencyStatus };
};

@Injectable()
export class ReadinessService {
  constructor(
    private readonly lifecycle: ProcessLifecycle,
    private readonly dataSource: DataSource,
    private readonly producer: MessageProducer,
    private readonly redis: Redis,
  ) {}

  async report(): Promise<ReadinessReport> {
    const reasons = this.lifecycle.notReadyReasons();
    return {
      status: reasons.length === 0 ? 'ready' : 'not-ready',
      reasons,
      dependencies: {
        database: await this.database(),
        kafka: this.producer.isConnected() ? 'up' : 'down',
        redis: this.redis.status === 'ready' ? 'up' : 'down',
      },
    };
  }

  private async database(): Promise<DependencyStatus> {
    const timeout = new AbortController();
    try {
      // Raw SQL: the smallest possible round trip, there is no entity to query.
      const answered = await Promise.race([
        this.dataSource.query('SELECT 1').then(() => true),
        sleep(DEPENDENCY_CHECK_TIMEOUT_MS, false, { signal: timeout.signal }),
      ]);
      return answered ? 'up' : 'down';
    } catch {
      return 'down';
    } finally {
      timeout.abort();
    }
  }
}
