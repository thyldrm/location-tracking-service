// Load test of the ingestion path: POST /locations at a constant arrival rate, then the freshness of the
// worker (ping accepted in the API -> processed in the worker), read from the services' Prometheus metrics.
//
//   docker compose run --rm k6 run /load/ingest.js
//   docker compose run --rm k6 run -e RATE=5000 -e DURATION=2m -e APIS=4 -e WORKERS=2 /load/ingest.js
//
// Options (k6 -e NAME=value):
//   RATE        pings per second (default 1000)
//   DURATION    length of the constant-rate phase (default 60s)
//   USERS       distinct simulated users (default 50000: at 10,000 pings/s every user pings every 5 s)
//   APIS        api containers to read metrics from (default 1; see load/compose.scale.yml; 0 skips the
//               service-side latency check, e.g. in Kubernetes: deploy/k8s/README.md)
//   WORKERS     worker containers to read metrics from (default 1; 0 skips the freshness check, e.g. to
//               build a backlog while the worker is stopped)
//   BASE_URL    API base URL the pings are sent to (default http://api:3000, every api container)
//   API_KEY     value of the x-api-key header (default: the compose development key)

import { check, sleep } from 'k6';
import exec from 'k6/execution';
import http from 'k6/http';
import { Gauge } from 'k6/metrics';

const RATE = Number(__ENV.RATE || 1000);
const DURATION = __ENV.DURATION || '60s';
const USERS = Number(__ENV.USERS || 50000);
const BASE_URL = __ENV.BASE_URL || 'http://api:3000';
// Compose names containers <project>-<service>-<n>; metrics are read from each one and added up.
const instances = (service, count) =>
  Array.from(
    { length: count },
    (_, index) => `http://location-tracking-${service}-${index + 1}:3000`,
  );
const API_INSTANCES = instances('api', Number(__ENV.APIS || 1));
const WORKER_INSTANCES = instances('worker', Number(__ENV.WORKERS || 1));
const API_KEY = __ENV.API_KEY || 'local-development-api-key-change-me-0123456789';

// SPEC.md §11: POST /locations p99 < 50 ms at target load; ping -> entry visible p99 < 1 s.
const LATENCY_TARGET_SECONDS = 0.05;
const FRESHNESS_TARGET_SECONDS = 1;
// k6 drops an iteration when no VU is free to start it; a handful while it adds VUs is not a failure.
const MAX_DROPPED_RATIO = 0.001;

// Results computed from the services' histograms in teardown; thresholds turn them into pass / fail.
const serverLatencyWithinTarget = new Gauge('server_latency_within_50ms_ratio');
const freshnessWithinTarget = new Gauge('freshness_within_1s_ratio');
const pingsProcessed = new Gauge('worker_pings_processed');
const transitions = new Gauge('worker_area_transitions');

/** "90s", "2m" or "1m30s" -> seconds. */
function seconds(duration) {
  let total = 0;
  for (const [, value, unit] of duration.matchAll(/(\d+)(h|m|s)/g)) {
    total += Number(value) * { h: 3600, m: 60, s: 1 }[unit];
  }
  return total;
}

export const options = {
  scenarios: {
    ingest: {
      // Open model: requests start at the given rate whether or not earlier ones have finished, like real
      // clients. A closed model (fixed VUs in a loop) would slow down with the server and hide its latency.
      executor: 'constant-arrival-rate',
      rate: RATE,
      timeUnit: '1s',
      duration: DURATION,
      // Enough for requests of 100 ms without starting new VUs during the test.
      preAllocatedVUs: Math.max(50, Math.ceil(RATE / 10)),
      // Enough for every request of 1 s to be in flight at once; beyond that k6 drops iterations.
      maxVUs: Math.max(100, RATE),
    },
  },
  // Spread requests over every api container when the service is scaled (docker compose --scale api=N).
  dns: { ttl: '0', select: 'roundRobin', policy: 'preferIPv4' },
  thresholds: {
    'http_req_duration{scenario:ingest}': [`p(99)<${LATENCY_TARGET_SECONDS * 1000}`],
    'checks{scenario:ingest}': ['rate>0.999'],
    // Iterations k6 could not start because every VU was busy: the system did not keep up with the rate.
    dropped_iterations: [`count<=${Math.ceil(RATE * seconds(DURATION) * MAX_DROPPED_RATIO)}`],
    ...(API_INSTANCES.length > 0 ? { server_latency_within_50ms_ratio: ['value>=0.99'] } : {}),
    ...(WORKER_INSTANCES.length > 0 ? { freshness_within_1s_ratio: ['value>=0.99'] } : {}),
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(99)', 'max'],
};

// Ten lanes of users cross four areas on a route of 40 steps; the other 90 lanes never enter an area.
// One user in ten therefore enters and leaves an area every ten steps, the rest only produces unchanged pings.
const ORIGIN = { lat: 41.1, lon: 28.9 };
const LANES = 100;
const LANE_SPACING = 0.0001;
const STEPS = 40;
const STEP_LENGTH = 0.0005;
const AREA_STEPS = [5, 15, 25, 35];
const AREA_LANES = 10;

function areaPolygon(firstStep) {
  const west = ORIGIN.lon + (firstStep - 0.5) * STEP_LENGTH;
  const east = ORIGIN.lon + (firstStep + 2.5) * STEP_LENGTH;
  const south = ORIGIN.lat - 0.5 * LANE_SPACING;
  const north = ORIGIN.lat + (AREA_LANES - 0.5) * LANE_SPACING;
  return {
    type: 'Polygon',
    coordinates: [
      [
        [west, south],
        [east, south],
        [east, north],
        [west, north],
        [west, south],
      ],
    ],
  };
}

function position(user, step) {
  return {
    latitude: ORIGIN.lat + (user % LANES) * LANE_SPACING,
    // Users start at different points of the route, so entries are spread over time.
    longitude: ORIGIN.lon + ((step + user) % STEPS) * STEP_LENGTH,
  };
}

/** Prometheus text format -> { 'name{labels}': value }, labels sorted so lookups do not depend on order. */
function parseMetrics(text) {
  const samples = {};
  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) continue;
    const match = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
    if (!match) continue;
    const labels = (match[2] || '')
      .split(',')
      .filter((label) => label !== '' && !label.startsWith('role='))
      .sort()
      .join(',');
    samples[`${match[1]}{${labels}}`] = Number(match[3]);
  }
  return samples;
}

function scrape(baseUrl) {
  const response = http.get(`${baseUrl}/metrics`, { tags: { name: 'metrics' } });
  if (response.status !== 200) {
    exec.test.abort(`GET ${baseUrl}/metrics answered ${response.status}`);
  }
  return parseMetrics(response.body);
}

/** Counters and histogram buckets of several instances add up to those of the whole service. */
function scrapeAll(baseUrls) {
  const total = {};
  for (const baseUrl of baseUrls) {
    for (const [key, value] of Object.entries(scrape(baseUrl))) {
      total[key] = (total[key] || 0) + value;
    }
  }
  return total;
}

function delta(after, before, key) {
  return (after[key] || 0) - (before[key] || 0);
}

function processedTotal(samples) {
  return ['unchanged', 'transition', 'out-of-order'].reduce(
    (sum, outcome) => sum + (samples[`location_pings_processed_total{outcome="${outcome}"}`] || 0),
    0,
  );
}

export function setup() {
  const headers = { 'content-type': 'application/json', 'x-api-key': API_KEY };
  let created = 0;
  AREA_STEPS.forEach((firstStep, index) => {
    const response = http.post(
      `${BASE_URL}/areas`,
      JSON.stringify({ name: `load-test-area-${index + 1}`, geometry: areaPolygon(firstStep) }),
      { headers, tags: { name: 'setup' } },
    );
    // 409: the area exists from an earlier run, with the same geometry.
    if (response.status !== 201 && response.status !== 409) {
      exec.test.abort(`POST /areas answered ${response.status}: ${response.body}`);
    }
    if (response.status === 201) created += 1;
  });
  if (created > 0) {
    // New areas reach the worker's index through the outbox and Kafka, within about a second.
    sleep(3);
  }
  return { api: scrapeAll(API_INSTANCES), worker: scrapeAll(WORKER_INSTANCES) };
}

export default function () {
  const iteration = exec.scenario.iterationInTest;
  const user = iteration % USERS;
  const step = Math.floor(iteration / USERS);
  const ping = {
    userId: `load-user-${user}`,
    ...position(user, step),
    timestamp: new Date().toISOString(),
    accuracy: 10,
  };
  const response = http.post(`${BASE_URL}/locations`, JSON.stringify(ping), {
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    tags: { name: 'POST /locations' },
  });
  check(response, { 'status is 202': (r) => r.status === 202 });
}

export function teardown(data) {
  if (API_INSTANCES.length > 0) reportServerLatency(data);
  if (WORKER_INSTANCES.length > 0) reportFreshness(data);
}

function reportServerLatency(data) {
  // The share of observations at or below the target is exact for a bucket boundary; no interpolation.
  const api = scrapeAll(API_INSTANCES);
  const route = 'method="POST",route="/locations",status_code="202"';
  const apiCount = delta(api, data.api, `http_request_duration_seconds_count{${route}}`);
  const apiFast = delta(
    api,
    data.api,
    `http_request_duration_seconds_bucket{le="${LATENCY_TARGET_SECONDS}",${route}}`,
  );
  serverLatencyWithinTarget.add(apiCount > 0 ? apiFast / apiCount : 0);
}

function reportFreshness(data) {
  // The worker may still be catching up: wait until its processed count stops growing.
  let worker = scrapeAll(WORKER_INSTANCES);
  for (let waited = 0; waited < 120; waited += 2) {
    sleep(2);
    const next = scrapeAll(WORKER_INSTANCES);
    const done = processedTotal(next) === processedTotal(worker);
    worker = next;
    if (done) break;
  }
  const workerCount = delta(worker, data.worker, 'location_ping_processing_delay_seconds_count{}');
  const workerFresh = delta(
    worker,
    data.worker,
    `location_ping_processing_delay_seconds_bucket{le="${FRESHNESS_TARGET_SECONDS}"}`,
  );

  freshnessWithinTarget.add(workerCount > 0 ? workerFresh / workerCount : 0);
  pingsProcessed.add(processedTotal(worker) - processedTotal(data.worker));
  transitions.add(
    delta(worker, data.worker, 'area_transitions_total{type="entered"}') +
      delta(worker, data.worker, 'area_transitions_total{type="exited"}'),
  );
}
