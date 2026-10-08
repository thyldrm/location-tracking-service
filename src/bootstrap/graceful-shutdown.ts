import { setTimeout as sleep } from 'node:timers/promises';
import type { ProcessLifecycle } from '../core/lifecycle/process-lifecycle.js';

export type ShutdownOptions = {
  /** Upper bound for the whole shutdown; past it the process exits with code 1. */
  timeoutMs: number;
  logger: {
    log(message: string, context?: string): void;
    error(message: string, context?: string): void;
  };
  exit: (code: number) => void;
};

const CONTEXT = 'Shutdown';

/**
 * Returns the function a signal handler calls to stop the process gracefully (SPEC.md §11, ADR 0010):
 *
 * 1. **Drain:** readiness starts failing, but requests are still served for `drainDelayMs`. An
 *    orchestrator removes a terminating pod from the load balancer asynchronously; closing the server at
 *    once would refuse the requests already on their way to it.
 * 2. **Close:** `app.close()` stops accepting connections, waits for requests in progress, then runs the
 *    shutdown hooks: consumers finish their batches and commit offsets, the relay finishes its pass, the
 *    producer flushes, pools close.
 * 3. **Exit:** the process ends when nothing is left to do. If closing fails or takes longer than
 *    `timeoutMs` (something hangs, or keeps the process alive), it exits with code 1 instead of waiting
 *    for the orchestrator to kill it.
 *
 * A second signal during shutdown is ignored.
 */
export function gracefulShutdown(
  app: { close(): Promise<void> },
  lifecycle: ProcessLifecycle,
  options: ShutdownOptions,
): (signal: string, drainDelayMs: number) => Promise<void> {
  let started = false;
  return async (signal, drainDelayMs) => {
    if (started) return;
    started = true;
    // Unreferenced: it does not keep the process alive, but fires if something else does.
    const deadline = setTimeout(() => {
      options.logger.error(`Shutdown not finished after ${options.timeoutMs} ms; exiting`, CONTEXT);
      options.exit(1);
    }, options.timeoutMs);
    deadline.unref();

    lifecycle.startDraining();
    options.logger.log(
      `${signal} received; draining for ${drainDelayMs} ms, then closing`,
      CONTEXT,
    );
    await sleep(drainDelayMs);
    try {
      await app.close();
      options.logger.log('Closed; exiting once pending work is done', CONTEXT);
    } catch (error) {
      clearTimeout(deadline);
      options.logger.error(`Shutdown failed: ${String(error)}`, CONTEXT);
      options.exit(1);
    }
  };
}
