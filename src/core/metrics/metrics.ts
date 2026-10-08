import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';

/** Latency buckets in seconds, from a fast HTTP request to a slow database query. */
const LATENCY_BUCKETS = [0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Delay from accepting a ping to having processed it; up to minutes while a dependency is down. */
const DELAY_BUCKETS = [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300, 900];

type Readable = {
  get(): Promise<{
    values: Array<{
      value: number;
      labels: Partial<Record<string, string | number>>;
      metricName?: string;
    }>;
  }>;
};

/**
 * Current value of a counter or gauge series (or of a histogram's `_sum` / `_count` with `metricName`).
 * For tests and diagnostics; Prometheus reads the registry instead.
 */
export async function metricValue(
  metric: Readable,
  labels: Record<string, string> = {},
  metricName?: string,
): Promise<number> {
  const { values } = await metric.get();
  const match = values.find(
    (entry) =>
      (metricName === undefined || entry.metricName === metricName) &&
      Object.entries(labels).every(([name, value]) => entry.labels[name] === value),
  );
  return match?.value ?? 0;
}

/** Numeric value of `circuit_breaker_state`. */
export const CircuitStateValue = { closed: 0, 'half-open': 1, open: 2 } as const;

/**
 * Every Prometheus metric of the service, defined in one place (SPEC.md §11).
 *
 * Names follow the Prometheus conventions: snake_case, the unit as suffix (`_seconds`), `_total` for
 * counters. Labels only take values from small fixed sets (route templates, outcomes), never ids or user
 * input: each distinct label value is a separate time series, and unbounded values would exhaust the
 * monitoring system ("cardinality explosion").
 *
 * Each application instance owns its registry instead of using prom-client's global one, so two
 * applications in one process (e2e tests) do not collide.
 */
export class Metrics {
  readonly registry = new Registry();

  // ---- HTTP (both roles) ----
  readonly httpRequestDuration = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'Duration of HTTP requests, by route template and status code.',
    labelNames: ['method', 'route', 'status_code'] as const,
    buckets: LATENCY_BUCKETS,
    registers: [this.registry],
  });

  // ---- Ingestion (API) ----
  readonly pingsAccepted = new Counter({
    name: 'location_pings_accepted_total',
    help: 'Pings acknowledged by Kafka and answered with 202.',
    registers: [this.registry],
  });

  readonly pingsRejected = new Counter({
    name: 'location_pings_rejected_total',
    help: 'Valid pings that were not accepted, by reason (rate-limited, unavailable, circuit-open).',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly rateLimiterFailOpen = new Counter({
    name: 'rate_limiter_fail_open_total',
    help: 'Requests allowed without a rate limit check because Redis was unavailable.',
    registers: [this.registry],
  });

  readonly circuitBreakerState = new Gauge({
    name: 'circuit_breaker_state',
    help: 'State of a circuit breaker: 0 closed, 1 half-open, 2 open.',
    labelNames: ['name'] as const,
    registers: [this.registry],
  });

  // ---- Entry detection (worker) ----
  readonly pingsProcessed = new Counter({
    name: 'location_pings_processed_total',
    help: 'Pings processed by the worker, by outcome (unchanged, transition, out-of-order).',
    labelNames: ['outcome'] as const,
    registers: [this.registry],
  });

  readonly pingProcessingDelay = new Histogram({
    name: 'location_ping_processing_delay_seconds',
    help: 'Time from accepting a ping in the API (receivedAt) to the end of its processing in the worker.',
    buckets: DELAY_BUCKETS,
    registers: [this.registry],
  });

  readonly pingsDeadLettered = new Counter({
    name: 'location_pings_dead_lettered_total',
    help: 'Pings sent to the dead letter topic, by reason (invalid-message, processing-failed).',
    labelNames: ['reason'] as const,
    registers: [this.registry],
  });

  readonly areaTransitions = new Counter({
    name: 'area_transitions_total',
    help: 'Area entries and exits recorded, by type (entered, exited).',
    labelNames: ['type'] as const,
    registers: [this.registry],
  });

  readonly areaIndexAreas = new Gauge({
    name: 'area_index_areas',
    help: 'Areas in the in-memory index of this worker.',
    registers: [this.registry],
  });

  readonly areaIndexLastLoad = new Gauge({
    name: 'area_index_last_load_timestamp_seconds',
    help: 'Unix time of the last successful full load of the area index.',
    registers: [this.registry],
  });

  // ---- Outbox relay (worker) ----
  readonly outboxPublished = new Counter({
    name: 'outbox_events_published_total',
    help: 'Outbox events published to Kafka.',
    registers: [this.registry],
  });

  readonly outboxPublishFailures = new Counter({
    name: 'outbox_publish_failures_total',
    help: 'Outbox events not published in a relay pass, by kind (unavailable, rejected).',
    labelNames: ['kind'] as const,
    registers: [this.registry],
  });

  constructor(role: string) {
    this.registry.setDefaultLabels({ role });
    // Process metrics: CPU, memory, garbage collection and, most telling for Node.js, event loop lag.
    collectDefaultMetrics({ register: this.registry });
  }
}
