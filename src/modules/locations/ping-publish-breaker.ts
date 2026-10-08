import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import type { Env } from '../../core/config/env.schema.js';
import { Clock } from '../../core/foundation/clock.js';
import { PublishError } from '../../core/messaging/message-producer.js';
import { CircuitStateValue, Metrics } from '../../core/metrics/metrics.js';
import { CircuitBreaker } from '../../core/resilience/circuit-breaker.js';

const NAME = 'kafka-ping-publish';

/**
 * Circuit breaker around publishing pings (ADR 0010). When the broker stops acknowledging, every
 * `POST /locations` would wait the full delivery timeout (3 s) before its 503; at thousands of requests per
 * second that holds thousands of requests, sockets and buffers open for nothing. After a few consecutive
 * timeouts the circuit opens and requests are answered 503 at once; one trial request every
 * `KAFKA_BREAKER_OPEN_MS` finds out whether the broker is back.
 *
 * Only outage symptoms count (`timeout`, `unavailable`). A full local queue is backpressure that already
 * fails fast, and a rejected message says nothing about the broker's availability.
 */
@Injectable()
export class PingPublishBreaker extends CircuitBreaker {
  constructor(
    config: ConfigService<Env, true>,
    clock: Clock,
    metrics: Metrics,
    @InjectPinoLogger(PingPublishBreaker.name) logger: PinoLogger,
  ) {
    const openDurationMs = config.get('KAFKA_BREAKER_OPEN_MS', { infer: true });
    super({
      failureThreshold: config.get('KAFKA_BREAKER_FAILURE_THRESHOLD', { infer: true }),
      openDurationMs,
      isFailure: (error) =>
        error instanceof PublishError &&
        (error.reason === 'timeout' || error.reason === 'unavailable'),
      now: () => clock.now().getTime(),
      onStateChange: (state, previous) => {
        metrics.circuitBreakerState.set({ name: NAME }, CircuitStateValue[state]);
        // One line per transition, not per rejected request.
        if (state === 'open') {
          logger.warn(
            { breaker: NAME, previous, openForMs: openDurationMs },
            'Circuit opened: answering pings with 503 without waiting for Kafka',
          );
        } else {
          logger.info({ breaker: NAME, previous, state }, `Circuit ${state}`);
        }
      },
    });
    metrics.circuitBreakerState.set({ name: NAME }, CircuitStateValue.closed);
  }
}
