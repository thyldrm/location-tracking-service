import type { ConfigService } from '@nestjs/config';
import type { PinoLogger } from 'nestjs-pino';
import type { Env } from '../../core/config/env.schema.js';
import type { RequestContext } from '../../core/context/request-context.js';
import { MessageProducer, type OutgoingMessage } from '../../core/messaging/message-producer.js';
import { Metrics, metricValue } from '../../core/metrics/metrics.js';
import type { Topic } from '../../core/messaging/topics.js';
import type { PingMessage } from '../locations/ping-message.js';
import { type ConsumedMessage, PingBatchHandler } from './ping-batch-handler.js';
import type { PingOutcome, PingProcessor } from './ping-processor.js';

class RecordingProducer extends MessageProducer {
  readonly published: { topic: Topic; message: OutgoingMessage }[] = [];

  async publish(topic: Topic, outgoing: OutgoingMessage): Promise<void> {
    this.published.push({ topic, message: outgoing });
  }

  isConnected(): boolean {
    return true;
  }
}

/** Runs pings through a script: each call takes the next behaviour for that ping id. */
class ScriptedProcessor {
  readonly calls: { pingId: string; correlationId: string | undefined }[] = [];
  private readonly scripts = new Map<string, (() => PingOutcome)[]>();
  private currentCorrelationId: string | undefined;

  script(pingId: string, ...behaviours: (() => PingOutcome)[]): void {
    this.scripts.set(pingId, behaviours);
  }

  setCorrelationId(id: string | undefined): void {
    this.currentCorrelationId = id;
  }

  async process(ping: PingMessage): Promise<PingOutcome> {
    this.calls.push({ pingId: ping.pingId, correlationId: this.currentCorrelationId });
    const next = this.scripts.get(ping.pingId)?.shift();
    await new Promise((resolve) => setTimeout(resolve, 1));
    return next ? next() : 'unchanged';
  }
}

const ok = (): PingOutcome => 'unchanged';
const bug = (): PingOutcome => {
  throw new TypeError('boom');
};
const databaseDown = (): PingOutcome => {
  throw new Error('Connection terminated unexpectedly');
};

let offset = 0;
function message(
  ping: Partial<PingMessage> & { pingId: string; userId: string },
  headers: Record<string, string> = {},
): ConsumedMessage {
  const value: PingMessage = {
    latitude: 40.99,
    longitude: 29.03,
    accuracy: null,
    timestamp: '2026-10-08T12:00:00.000Z',
    receivedAt: '2026-10-08T12:00:00.100Z',
    ...ping,
  };
  return {
    topic: 'location.pings.v1',
    partition: 3,
    offset: String(offset++),
    key: Buffer.from(ping.userId),
    value: Buffer.from(JSON.stringify(value)),
    headers: { 'schema-version': '1', 'x-request-id': `req-${ping.pingId}`, ...headers },
  };
}

function setup() {
  const processor = new ScriptedProcessor();
  const producer = new RecordingProducer();
  const requestContext = {
    run: async <T>(correlationId: string, work: () => T): Promise<Awaited<T>> => {
      processor.setCorrelationId(correlationId);
      try {
        return await work();
      } finally {
        processor.setCorrelationId(undefined);
      }
    },
  } as unknown as RequestContext;
  const config = { get: () => 3 } as unknown as ConfigService<Env, true>;
  const logger = { warn: () => undefined, error: () => undefined } as unknown as PinoLogger;
  const metrics = new Metrics('test');
  // receivedAt of every test message is 12:00:00.100, so each ping is processed 0.5 s after acceptance.
  const clock = { now: () => new Date('2026-10-08T12:00:00.600Z') };
  const handler = new PingBatchHandler(
    processor as unknown as PingProcessor,
    producer,
    requestContext,
    config,
    logger,
    clock,
    metrics,
  );
  return { handler, processor, producer, metrics };
}

describe('PingBatchHandler', () => {
  it('processes every ping with the correlation id of the request that produced it', async () => {
    const { handler, processor } = setup();

    await handler.handle([
      message({ pingId: 'p1', userId: 'u1' }),
      message({ pingId: 'p2', userId: 'u2' }),
    ]);

    expect(processor.calls.toSorted((a, b) => a.pingId.localeCompare(b.pingId))).toEqual([
      { pingId: 'p1', correlationId: 'req-p1' },
      { pingId: 'p2', correlationId: 'req-p2' },
    ]);
  });

  it('keeps the order of the pings of one user', async () => {
    const { handler, processor } = setup();

    await handler.handle([
      message({ pingId: 'a1', userId: 'u1' }),
      message({ pingId: 'b1', userId: 'u2' }),
      message({ pingId: 'a2', userId: 'u1' }),
      message({ pingId: 'a3', userId: 'u1' }),
    ]);

    const ofUser1 = processor.calls.map((call) => call.pingId).filter((id) => id.startsWith('a'));
    expect(ofUser1).toEqual(['a1', 'a2', 'a3']);
  });

  it.each([
    ['not JSON', { value: Buffer.from('{oops') }],
    ['an unknown schema version', { headers: { 'schema-version': '2' } }],
    ['missing fields', { value: Buffer.from('{"pingId":"x"}') }],
  ])(
    'sends a message that is %s to the dead letter topic and goes on',
    async (_label, override) => {
      const { handler, processor, producer } = setup();
      const bad = { ...message({ pingId: 'bad', userId: 'u1' }), ...override };

      await handler.handle([bad, message({ pingId: 'good', userId: 'u2' })]);

      expect(processor.calls.map((call) => call.pingId)).toEqual(['good']);
      expect(producer.published).toHaveLength(1);
      expect(producer.published[0]?.topic).toBe('location.pings.v1.dlq');
      expect(producer.published[0]?.message.headers).toMatchObject({
        'x-dlq-reason': 'invalid-message',
        'x-original-topic': 'location.pings.v1',
        'x-original-partition': '3',
        'x-original-offset': bad.offset,
      });
    },
  );

  it('retries a failing ping and succeeds without a dead letter', async () => {
    const { handler, processor, producer } = setup();
    processor.script('p1', bug, ok);

    await handler.handle([message({ pingId: 'p1', userId: 'u1' })]);

    expect(processor.calls).toHaveLength(2);
    expect(producer.published).toEqual([]);
  });

  it('dead-letters a ping that keeps failing, keeping the original message and the error', async () => {
    const { handler, processor, producer } = setup();
    processor.script('p1', bug, bug, bug);
    const original = message({ pingId: 'p1', userId: 'u1' });

    await handler.handle([original, message({ pingId: 'p2', userId: 'u1' })]);

    expect(processor.calls.map((call) => call.pingId)).toEqual(['p1', 'p1', 'p1', 'p2']);
    const deadLetter = producer.published[0]?.message;
    expect(deadLetter?.key).toBe('u1');
    expect(deadLetter?.value).toEqual(original.value);
    expect(deadLetter?.headers).toMatchObject({
      'x-request-id': 'req-p1',
      'x-dlq-reason': 'processing-failed',
      'x-dlq-error': 'TypeError: boom',
      'x-dlq-attempts': '3',
    });
  });

  it('counts outcomes and dead letters and measures the delay since acceptance', async () => {
    const { handler, processor, metrics } = setup();
    processor.script('p2', bug, bug, bug);

    await handler.handle([
      message({ pingId: 'p1', userId: 'u1' }),
      message({ pingId: 'p2', userId: 'u2' }),
      message({ pingId: 'p3', userId: 'u3' }, { 'schema-version': '9' }),
    ]);

    expect(await metricValue(metrics.pingsProcessed, { outcome: 'unchanged' })).toBe(1);
    expect(await metricValue(metrics.pingsDeadLettered, { reason: 'processing-failed' })).toBe(1);
    expect(await metricValue(metrics.pingsDeadLettered, { reason: 'invalid-message' })).toBe(1);
    const delay = metrics.pingProcessingDelay;
    expect(await metricValue(delay, {}, 'location_ping_processing_delay_seconds_count')).toBe(1);
    expect(await metricValue(delay, {}, 'location_ping_processing_delay_seconds_sum')).toBeCloseTo(
      0.5,
    );
  });

  it('rethrows a transient error without dead-lettering, after the other users finished', async () => {
    const { handler, processor, producer } = setup();
    processor.script('p1', databaseDown);

    await expect(
      handler.handle([
        message({ pingId: 'p1', userId: 'u1' }),
        message({ pingId: 'p2', userId: 'u2' }),
      ]),
    ).rejects.toThrow('Connection terminated unexpectedly');

    expect(producer.published).toEqual([]);
    expect(processor.calls.map((call) => call.pingId).toSorted()).toEqual(['p1', 'p2']);
  });
});
