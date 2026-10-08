import { ThrottledLog } from './throttled-log.js';

describe('ThrottledLog', () => {
  it('writes at most once per interval and reports what it suppressed', () => {
    let now = 0;
    const log = new ThrottledLog(60_000, () => now);
    const writes: number[] = [];

    log.record((suppressed) => writes.push(suppressed));
    now = 1_000;
    log.record((suppressed) => writes.push(suppressed));
    now = 2_000;
    log.record((suppressed) => writes.push(suppressed));
    now = 61_000;
    log.record((suppressed) => writes.push(suppressed));

    expect(writes).toEqual([0, 2]);
  });
});
