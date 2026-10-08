import { Global, Injectable, Module } from '@nestjs/common';

/** A condition this process must meet before it takes traffic, e.g. "the area index is loaded". */
export type ReadinessGate = { name: string; isReady: () => boolean };

/**
 * The state of this process that decides readiness (ADR 0010): whether its own startup work is done, and
 * whether it is shutting down. Deliberately not the state of shared dependencies: when the database is
 * down for one instance it is down for all of them, and failing readiness everywhere at once would take
 * every instance out of the load balancer, turning a partial outage (only some endpoints need the
 * database) into a total one, with the load balancer's error instead of the service's own 503.
 */
@Injectable()
export class ProcessLifecycle {
  private draining = false;
  private readonly gates: ReadinessGate[] = [];

  addReadinessGate(name: string, isReady: () => boolean): void {
    this.gates.push({ name, isReady });
  }

  /** From now on readiness fails, so the load balancer stops sending new requests; existing ones finish. */
  startDraining(): void {
    this.draining = true;
  }

  get isDraining(): boolean {
    return this.draining;
  }

  /** Why the process is not ready; empty when it is. */
  notReadyReasons(): string[] {
    const reasons = this.gates.filter((gate) => !gate.isReady()).map((gate) => gate.name);
    return this.draining ? ['draining', ...reasons] : reasons;
  }
}

@Global()
@Module({
  providers: [ProcessLifecycle],
  exports: [ProcessLifecycle],
})
export class LifecycleModule {}
