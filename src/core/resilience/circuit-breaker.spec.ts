import { CircuitBreaker, CircuitOpenError, type CircuitState } from './circuit-breaker.js';

class DependencyDown extends Error {}

const fail = (): Promise<never> => Promise.reject(new DependencyDown('down'));
const succeed = (): Promise<string> => Promise.resolve('ok');

function setup() {
  let now = 0;
  const transitions: string[] = [];
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    openDurationMs: 5_000,
    isFailure: (error) => error instanceof DependencyDown,
    now: () => now,
    onStateChange: (state: CircuitState, previous: CircuitState) => {
      transitions.push(`${previous}->${state}`);
    },
  });
  const advance = (ms: number): void => {
    now += ms;
  };
  return { breaker, transitions, advance };
}

async function failTimes(breaker: CircuitBreaker, times: number): Promise<void> {
  for (let call = 0; call < times; call++) {
    await breaker.execute(fail).catch(() => undefined);
  }
}

describe('CircuitBreaker', () => {
  it('stays closed below the threshold; a success or an unrelated error resets the count', async () => {
    const { breaker } = setup();

    await failTimes(breaker, 2);
    await breaker.execute(succeed);
    await failTimes(breaker, 2);
    await breaker
      .execute(() => Promise.reject(new TypeError('a bug, not an outage')))
      .catch(() => undefined);
    await failTimes(breaker, 2);

    expect(breaker.state).toBe('closed');
  });

  it('opens after consecutive failures and then rejects without calling the dependency', async () => {
    const { breaker, advance } = setup();
    await failTimes(breaker, 3);
    advance(1_000);
    const work = vi.fn<() => Promise<string>>(succeed);

    const error: unknown = await breaker.execute(work).catch((caught: unknown) => caught);

    expect(breaker.state).toBe('open');
    expect(work).not.toHaveBeenCalled();
    expect(error).toBeInstanceOf(CircuitOpenError);
    expect((error as CircuitOpenError).retryAfterMs).toBe(4_000);
  });

  it('lets one trial call through after the open duration and closes when it succeeds', async () => {
    const { breaker, advance, transitions } = setup();
    await failTimes(breaker, 3);
    advance(5_000);
    const trial = Promise.withResolvers<string>();

    const trialCall = breaker.execute(() => trial.promise);
    // While the trial is in flight, other calls are still rejected.
    await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
    trial.resolve('ok');

    await expect(trialCall).resolves.toBe('ok');
    expect(breaker.state).toBe('closed');
    expect(transitions).toEqual(['closed->open', 'open->half-open', 'half-open->closed']);
  });

  it('opens again for a full period when the trial fails', async () => {
    const { breaker, advance } = setup();
    await failTimes(breaker, 3);
    advance(5_000);

    await breaker.execute(fail).catch(() => undefined);
    advance(4_999);

    expect(breaker.state).toBe('open');
    await expect(breaker.execute(succeed)).rejects.toBeInstanceOf(CircuitOpenError);
  });

  it('ignores late results of calls admitted before the circuit opened', async () => {
    const { breaker } = setup();
    const slow = Promise.withResolvers<string>();
    const slowCall = breaker.execute(() => slow.promise);

    await failTimes(breaker, 3);
    slow.resolve('late success');
    await slowCall;

    expect(breaker.state).toBe('open');
  });
});
