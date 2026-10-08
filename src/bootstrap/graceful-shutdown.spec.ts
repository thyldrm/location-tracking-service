import { ProcessLifecycle } from '../core/lifecycle/process-lifecycle.js';
import { gracefulShutdown } from './graceful-shutdown.js';

function setup(close: () => Promise<void>, timeoutMs = 1_000) {
  const lifecycle = new ProcessLifecycle();
  const events: string[] = [];
  const exit = vi.fn<(code: number) => void>();
  const shutdown = gracefulShutdown(
    {
      close: async () => {
        events.push(`close (draining: ${lifecycle.isDraining})`);
        await close();
      },
    },
    lifecycle,
    {
      timeoutMs,
      logger: { log: () => undefined, error: (message) => events.push(message) },
      exit,
    },
  );
  return { shutdown, lifecycle, events, exit };
}

describe('gracefulShutdown', () => {
  it('fails readiness first and closes only after the drain delay', async () => {
    const { shutdown, lifecycle, events } = setup(() => Promise.resolve());

    const started = performance.now();
    const done = shutdown('SIGTERM', 100);
    expect(lifecycle.isDraining).toBe(true);
    expect(events).toEqual([]);
    await done;

    expect(performance.now() - started).toBeGreaterThanOrEqual(95);
    expect(events).toEqual(['close (draining: true)']);
  });

  it('ignores a second signal', async () => {
    const { shutdown, events } = setup(() => Promise.resolve());

    await Promise.all([shutdown('SIGTERM', 10), shutdown('SIGINT', 0)]);

    expect(events).toHaveLength(1);
  });

  it('exits with code 1 when closing takes longer than the timeout', async () => {
    const { shutdown, exit, events } = setup(() => new Promise(() => undefined), 50);

    void shutdown('SIGTERM', 0);
    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(1);
    });

    expect(events.at(-1)).toContain('not finished after 50 ms');
  });

  it('exits with code 1 when closing fails', async () => {
    const { shutdown, exit } = setup(() => Promise.reject(new Error('pool stuck')));

    await shutdown('SIGTERM', 0);

    expect(exit).toHaveBeenCalledWith(1);
  });
});
