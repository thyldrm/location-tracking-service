import { publishInKeyOrder } from './publish-in-key-order.js';

type Row = { id: string; messageKey: string };

const row = (id: string): Row => ({ id, messageKey: id.slice(0, 1) });

/** A publish function whose calls the test acknowledges or fails one by one. */
function controlledPublish() {
  const pending = new Map<string, PromiseWithResolvers<void>>();
  const calls: string[] = [];
  return {
    calls,
    publish: (item: Row): Promise<void> => {
      calls.push(item.id);
      const call = Promise.withResolvers<void>();
      pending.set(item.id, call);
      return call.promise;
    },
    ack: async (id: string): Promise<void> => {
      pending.get(id)?.resolve();
      await new Promise((resolve) => setImmediate(resolve));
    },
    fail: async (id: string): Promise<void> => {
      pending.get(id)?.reject(new Error(`failed ${id}`));
      await new Promise((resolve) => setImmediate(resolve));
    },
  };
}

describe('publishInKeyOrder', () => {
  it('sends the next row of a key only after the previous one was acknowledged', async () => {
    const broker = controlledPublish();
    const result = publishInKeyOrder([row('a1'), row('a2'), row('a3')], broker.publish);

    expect(broker.calls).toEqual(['a1']);
    await broker.ack('a1');
    expect(broker.calls).toEqual(['a1', 'a2']);
    await broker.ack('a2');
    await broker.ack('a3');

    expect((await result).published.map((item) => item.id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('sends the first row of every key at once, in input order', async () => {
    const broker = controlledPublish();
    const result = publishInKeyOrder([row('a1'), row('b1'), row('a2'), row('c1')], broker.publish);

    expect(broker.calls).toEqual(['a1', 'b1', 'c1']);
    await broker.ack('b1');
    await broker.ack('c1');
    await broker.ack('a1');
    await broker.ack('a2');

    // Reported in input order, whatever the order of the acknowledgements.
    expect((await result).published.map((item) => item.id)).toEqual(['a1', 'b1', 'a2', 'c1']);
  });

  it('stops a key at its first failure and keeps publishing the other keys', async () => {
    const broker = controlledPublish();
    const result = publishInKeyOrder([row('a1'), row('b1'), row('a2'), row('b2')], broker.publish);

    await broker.fail('a1');
    await broker.ack('b1');
    await broker.ack('b2');
    const { published, failed } = await result;

    expect(broker.calls).not.toContain('a2');
    expect(published.map((item) => item.id)).toEqual(['b1', 'b2']);
    expect(failed).toEqual([{ row: row('a1'), error: new Error('failed a1') }]);
  });

  it('does nothing for an empty batch', async () => {
    const publish = vi.fn<(item: Row) => Promise<void>>();

    expect(await publishInKeyOrder([], publish)).toEqual({ published: [], failed: [] });
    expect(publish).not.toHaveBeenCalled();
  });
});
