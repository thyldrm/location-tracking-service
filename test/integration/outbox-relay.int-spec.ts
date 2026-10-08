import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { DataSource } from 'typeorm';
import type { Env } from '../../src/core/config/env.schema.js';
import { UuidV7Generator } from '../../src/core/foundation/id-generator.js';
import {
  MessageProducer,
  type OutgoingMessage,
  PublishError,
  type PublishFailureReason,
} from '../../src/core/messaging/message-producer.js';
import { type Topic, Topics } from '../../src/core/messaging/topics.js';
import { OutboxEventEntity } from '../../src/modules/outbox/outbox-event.entity.js';
import { OutboxRelay } from '../../src/modules/outbox/outbox-relay.js';
import { createTestDataSource, truncateAllTables } from '../support/test-env.js';

const ids = new UuidV7Generator();

/** Records what would have been sent to Kafka; can fail chosen events or hold every send. */
class FakeProducer extends MessageProducer {
  readonly sent: Array<{ topic: Topic; key: string | null; eventId: string }> = [];
  failures = new Map<string, PublishFailureReason>();
  /** While set, every send waits for it. */
  gate: Promise<void> | undefined;
  /** Resolved when a send starts waiting on the gate. */
  readonly sendStarted = Promise.withResolvers<void>();

  async publish(topic: Topic, message: OutgoingMessage): Promise<void> {
    const { eventId } = JSON.parse(String(message.value)) as { eventId: string };
    if (this.gate) {
      this.sendStarted.resolve();
      await this.gate;
    }
    const failure = this.failures.get(eventId);
    if (failure) {
      throw new PublishError(failure);
    }
    this.sent.push({ topic, key: message.key, eventId });
  }

  isConnected(): boolean {
    return true;
  }
}

const silentLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as PinoLogger;

describe('OutboxRelay (integration)', () => {
  let dataSource: DataSource;
  let second: DataSource;
  let producer: FakeProducer;
  const settings: Partial<Env> = {};

  const relayOn = (source: DataSource, fake: MessageProducer): OutboxRelay =>
    new OutboxRelay(
      source,
      fake,
      { get: (key: keyof Env) => settings[key] } as ConfigService<Env, true>,
      silentLogger,
    );

  /** Inserts events with increasing created_at; returns their ids in that order. */
  const insertEvents = async (
    events: Array<{ key: string; topic?: string }>,
  ): Promise<string[]> => {
    const base = Date.now();
    const rows = events.map((event, position) => {
      const id = ids.next();
      return {
        id,
        topic: event.topic ?? Topics.AreaEntries,
        messageKey: event.key,
        eventType: 'area.entered',
        payload: { eventId: id },
        headers: { 'x-request-id': `corr-${id}` },
        createdAt: new Date(base + position),
      };
    });
    await dataSource.getRepository(OutboxEventEntity).insert(rows);
    return rows.map((row) => row.id);
  };

  const rowsById = async (): Promise<Map<string, OutboxEventEntity>> =>
    new Map((await dataSource.getRepository(OutboxEventEntity).find()).map((row) => [row.id, row]));

  beforeAll(async () => {
    [dataSource, second] = await Promise.all([createTestDataSource(), createTestDataSource()]);
  });

  beforeEach(async () => {
    await truncateAllTables(dataSource);
    Object.assign(settings, { OUTBOX_BATCH_SIZE: 100, OUTBOX_MAX_ATTEMPTS: 3 });
    producer = new FakeProducer();
  });

  afterAll(async () => {
    await Promise.all([dataSource.destroy(), second.destroy()]);
  });

  it('publishes unpublished events oldest first and marks them as published', async () => {
    const [first, other, third] = await insertEvents([{ key: 'u1' }, { key: 'u2' }, { key: 'u1' }]);

    const pass = await relayOn(dataSource, producer).relayOnce();

    expect(pass).toEqual({ role: 'leader', fetched: 3, published: 3, rejected: 0, unavailable: 0 });
    expect(producer.sent.filter((message) => message.key === 'u1')).toEqual([
      { topic: Topics.AreaEntries, key: 'u1', eventId: first },
      { topic: Topics.AreaEntries, key: 'u1', eventId: third },
    ]);
    expect(producer.sent.map((message) => message.eventId)).toContain(other);
    for (const row of (await rowsById()).values()) {
      expect(row.publishedAt).toBeInstanceOf(Date);
    }
    expect(await relayOn(dataSource, producer).relayOnce()).toMatchObject({ fetched: 0 });
  });

  it('publishes at most one batch per pass', async () => {
    settings.OUTBOX_BATCH_SIZE = 2;
    const [first, secondId] = await insertEvents([{ key: 'a' }, { key: 'b' }, { key: 'c' }]);

    expect(await relayOn(dataSource, producer).relayOnce()).toMatchObject({ published: 2 });
    expect(producer.sent.map((message) => message.eventId).toSorted()).toEqual(
      [first, secondId].toSorted(),
    );
  });

  it('leaves events untouched while Kafka does not accept them, without counting attempts', async () => {
    const [id] = await insertEvents([{ key: 'u1' }]);
    producer.failures.set(id ?? '', 'timeout');

    const pass = await relayOn(dataSource, producer).relayOnce();

    expect(pass).toMatchObject({ published: 0, rejected: 0, unavailable: 1 });
    expect((await rowsById()).get(id ?? '')).toMatchObject({
      publishedAt: null,
      attempts: 0,
      lastError: null,
    });
  });

  it('never lets an event overtake an earlier event of the same key that failed', async () => {
    const [first, later] = await insertEvents([{ key: 'u1' }, { key: 'u1' }]);
    producer.failures.set(first ?? '', 'timeout');

    await relayOn(dataSource, producer).relayOnce();
    expect(producer.sent).toEqual([]);

    producer.failures.clear();
    await relayOn(dataSource, producer).relayOnce();
    expect(producer.sent.map((message) => message.eventId)).toEqual([first, later]);
  });

  it('counts rejections and parks an event after OUTBOX_MAX_ATTEMPTS, other events keep flowing', async () => {
    const [bad, unknownTopic] = await insertEvents([
      { key: 'u1' },
      { key: 'u2', topic: 'no.such.topic' },
    ]);
    producer.failures.set(bad ?? '', 'rejected');
    const relay = relayOn(dataSource, producer);

    for (let pass = 0; pass < 3; pass++) {
      expect(await relay.relayOnce()).toMatchObject({ rejected: 2 });
    }
    const [good] = await insertEvents([{ key: 'u3' }]);
    const afterParking = await relay.relayOnce();

    expect(afterParking).toMatchObject({ fetched: 1, published: 1 });
    expect(producer.sent.map((message) => message.eventId)).toEqual([good]);
    const rows = await rowsById();
    expect(rows.get(bad ?? '')).toMatchObject({ publishedAt: null, attempts: 3 });
    expect(rows.get(bad ?? '')?.lastError).toContain('rejected');
    expect(rows.get(unknownTopic ?? '')?.lastError).toContain('Unknown topic "no.such.topic"');
  });

  it('lets one instance relay at a time; the other stays on standby', async () => {
    const [id] = await insertEvents([{ key: 'u1' }]);
    const gate = Promise.withResolvers<void>();
    producer.gate = gate.promise;
    const otherProducer = new FakeProducer();

    const leaderPass = relayOn(dataSource, producer).relayOnce();
    await producer.sendStarted.promise; // the leader holds the lock and is publishing
    const standbyPass = await relayOn(second, otherProducer).relayOnce();
    gate.resolve();

    expect(standbyPass).toEqual({ role: 'standby' });
    expect(await leaderPass).toMatchObject({ role: 'leader', published: 1 });
    expect(otherProducer.sent).toEqual([]);
    // The lock ended with the leader's transaction: the other instance can take over at once.
    expect(await relayOn(second, otherProducer).relayOnce()).toMatchObject({
      role: 'leader',
      fetched: 0,
    });
    expect((await rowsById()).get(id ?? '')?.publishedAt).toBeInstanceOf(Date);
  });
});
