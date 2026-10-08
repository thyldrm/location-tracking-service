import { ProcessLifecycle } from './process-lifecycle.js';

describe('ProcessLifecycle', () => {
  it('is ready once every gate is met', () => {
    const lifecycle = new ProcessLifecycle();
    let loaded = false;
    lifecycle.addReadinessGate('area-index', () => loaded);

    expect(lifecycle.notReadyReasons()).toEqual(['area-index']);
    loaded = true;
    expect(lifecycle.notReadyReasons()).toEqual([]);
  });

  it('is never ready again once draining has started', () => {
    const lifecycle = new ProcessLifecycle();
    lifecycle.addReadinessGate('area-index', () => false);

    lifecycle.startDraining();

    expect(lifecycle.isDraining).toBe(true);
    expect(lifecycle.notReadyReasons()).toEqual(['draining', 'area-index']);
  });
});
