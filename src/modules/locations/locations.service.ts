import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema.js';
import { RequestContext } from '../../core/context/request-context.js';
import {
  ServiceUnavailableError,
  TooManyRequestsError,
  ValidationError,
} from '../../core/errors/app-errors.js';
import { Clock } from '../../core/foundation/clock.js';
import { IdGenerator } from '../../core/foundation/id-generator.js';
import { MessageProducer, PublishError } from '../../core/messaging/message-producer.js';
import { Topics } from '../../core/messaging/topics.js';
import { RateLimiter, type RateLimitPolicy } from '../../core/rate-limit/rate-limiter.js';
import type { LocationPingInput } from './location.schemas.js';
import { PING_SCHEMA_VERSION, type PingMessage } from './ping-message.js';

export type AcceptedPing = { pingId: string; status: 'accepted' };

/**
 * Accepts location pings: validates their time, applies the per-user rate limit and publishes them to
 * Kafka. Nothing is written to the database here; the worker processes the pings asynchronously.
 */
@Injectable()
export class LocationsService {
  private readonly maxFutureSkewMs: number;
  private readonly maxAgeMs: number;
  private readonly rateLimit: RateLimitPolicy;

  constructor(
    config: ConfigService<Env, true>,
    private readonly producer: MessageProducer,
    private readonly rateLimiter: RateLimiter,
    private readonly ids: IdGenerator,
    private readonly clock: Clock,
    private readonly requestContext: RequestContext,
  ) {
    this.maxFutureSkewMs = config.get('PING_MAX_FUTURE_SKEW_MS', { infer: true });
    this.maxAgeMs = config.get('PING_MAX_AGE_MS', { infer: true });
    this.rateLimit = {
      limit: config.get('RATE_LIMIT_PINGS_PER_WINDOW', { infer: true }),
      windowMs: config.get('RATE_LIMIT_WINDOW_MS', { infer: true }),
    };
  }

  async accept(ping: LocationPingInput): Promise<AcceptedPing> {
    const receivedAt = this.clock.now();
    this.assertPlausibleTimestamp(ping.timestamp, receivedAt);

    const decision = await this.rateLimiter.consume(`pings:${ping.userId}`, this.rateLimit);
    if (!decision.allowed) {
      throw new TooManyRequestsError(
        'Too many location pings for this user.',
        Math.ceil(decision.retryAfterMs / 1000),
      );
    }

    const pingId = this.ids.next();
    const message: PingMessage = {
      pingId,
      userId: ping.userId,
      latitude: ping.latitude,
      longitude: ping.longitude,
      accuracy: ping.accuracy ?? null,
      timestamp: ping.timestamp.toISOString(),
      receivedAt: receivedAt.toISOString(),
    };

    try {
      // The key is the user id: all pings of a user land in one partition and are consumed in order.
      await this.producer.publish(Topics.LocationPings, {
        key: ping.userId,
        value: JSON.stringify(message),
        headers: {
          'x-request-id': this.requestContext.correlationId ?? pingId,
          'content-type': 'application/json',
          'schema-version': String(PING_SCHEMA_VERSION),
        },
      });
    } catch (error) {
      if (error instanceof PublishError) {
        // A full local queue clears quickly; an unreachable broker usually takes longer.
        const retryAfterSeconds = error.reason === 'queue-full' ? 1 : 5;
        throw new ServiceUnavailableError(
          'Location ingestion is temporarily unavailable. Retry the request.',
          retryAfterSeconds,
          { cause: error },
        );
      }
      throw error;
    }

    return { pingId, status: 'accepted' };
  }

  /**
   * The client clock is trusted within limits: far-future timestamps (a wrong device clock) would block
   * every later ping of the user as "out of order", and very old ones are not "the current location".
   */
  private assertPlausibleTimestamp(timestamp: Date, receivedAt: Date): void {
    const offsetMs = timestamp.getTime() - receivedAt.getTime();
    if (offsetMs > this.maxFutureSkewMs) {
      throw new ValidationError('Request body is invalid.', [
        {
          path: 'timestamp',
          message: `must not be more than ${this.maxFutureSkewMs / 1000} s in the future`,
        },
      ]);
    }
    if (-offsetMs > this.maxAgeMs) {
      throw new ValidationError('Request body is invalid.', [
        { path: 'timestamp', message: `must not be older than ${this.maxAgeMs / 1000} s` },
      ]);
    }
  }
}
