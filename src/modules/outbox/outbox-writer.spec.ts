import type { EntityManager } from 'typeorm';
import type { RequestContext } from '../../core/context/request-context.js';
import { Topics } from '../../core/messaging/topics.js';
import { OutboxEventEntity } from './outbox-event.entity.js';
import { OutboxWriter } from './outbox-writer.js';

const NOW = new Date('2026-10-08T10:00:00.000Z');
const EVENT_ID = '0199b1a2-0000-7000-8000-000000000001';

function fakeManager(isTransactionActive: boolean) {
  const insert = vi.fn<(...args: unknown[]) => Promise<void>>().mockResolvedValue(undefined);
  const manager = { queryRunner: { isTransactionActive }, insert } as unknown as EntityManager;
  return { manager, insert };
}

function writer(correlationId: string | undefined): OutboxWriter {
  return new OutboxWriter({ next: () => EVENT_ID }, { now: () => NOW }, {
    correlationId,
  } as RequestContext);
}

const event = {
  topic: Topics.AreaLifecycle,
  key: 'area-1',
  eventType: 'area.created',
  aggregateType: 'area',
  aggregateId: 'area-1',
  payload: { areaId: 'area-1' },
};

describe('OutboxWriter', () => {
  it('inserts the event envelope with its routing data and headers', async () => {
    const { manager, insert } = fakeManager(true);

    const envelope = await writer('request-1').append(manager, event);

    expect(envelope).toEqual({
      eventId: EVENT_ID,
      eventType: 'area.created',
      schemaVersion: 1,
      occurredAt: NOW.toISOString(),
      aggregateType: 'area',
      aggregateId: 'area-1',
      correlationId: 'request-1',
      payload: { areaId: 'area-1' },
    });
    expect(insert).toHaveBeenCalledWith(OutboxEventEntity, {
      id: EVENT_ID,
      topic: 'area.lifecycle.v1',
      messageKey: 'area-1',
      eventType: 'area.created',
      payload: envelope,
      headers: {
        'x-request-id': 'request-1',
        'content-type': 'application/json',
        'schema-version': '1',
      },
    });
  });

  it('starts a new correlation id when there is no current unit of work', async () => {
    const { manager } = fakeManager(true);

    const envelope = await writer(undefined).append(manager, event);

    expect(envelope.correlationId).toBe(EVENT_ID);
  });

  it('refuses to write outside a transaction', async () => {
    const { manager, insert } = fakeManager(false);

    await expect(writer('request-1').append(manager, event)).rejects.toThrow(
      /inside the transaction/,
    );
    expect(insert).not.toHaveBeenCalled();
  });
});
