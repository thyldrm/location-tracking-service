import { Injectable } from '@nestjs/common';
import { CLS_ID, ClsService } from 'nestjs-cls';
import { PinoLogger } from 'nestjs-pino';

/**
 * Access to the correlation id of the unit of work currently executing (an HTTP request or, in the
 * worker, a consumed message), without passing it through every function call.
 *
 * Backed by Node's AsyncLocalStorage (via nestjs-cls), which keeps a value attached to an
 * asynchronous call chain across every `await`. Business code depends on this class, not on the
 * underlying library.
 */
@Injectable()
export class RequestContext {
  constructor(
    private readonly cls: ClsService,
    private readonly logger: PinoLogger,
  ) {}

  /** The current correlation id, or `undefined` outside of any unit of work (e.g. during startup). */
  get correlationId(): string | undefined {
    return this.cls.isActive() ? this.cls.getId() : undefined;
  }

  /**
   * Runs `work` as its own unit of work: the correlation id is available through `correlationId`
   * and is attached to every log line written inside, exactly like for an HTTP request.
   * Used by non-HTTP entry points such as Kafka consumers.
   */
  run<T>(correlationId: string, work: () => T): T {
    return this.cls.run(() => {
      this.cls.set(CLS_ID, correlationId);
      return this.logger.runInContext(work, { bindings: { correlationId } });
    });
  }
}
