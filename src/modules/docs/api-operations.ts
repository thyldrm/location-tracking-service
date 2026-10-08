import type { z } from 'zod';
import { listLogsQuerySchema } from '../area-entries/area-entry.schemas.js';
import {
  type AreaLimits,
  areaIdParamsSchema,
  createAreaSchema,
  listAreasQuerySchema,
} from '../areas/area.schemas.js';
import { locationPingSchema } from '../locations/location.schemas.js';
import {
  acceptedPingSchema,
  areaEntrySchema,
  areaSchema,
  livenessSchema,
  metricsSchema,
  pageSchema,
  problemSchema,
  readinessSchema,
} from './response-schemas.js';

export type ResponseHeader = 'location' | 'idempotent-replayed' | 'retry-after';

export type ApiResponse = {
  description: string;
  schema: z.ZodType;
  /** `application/json` unless stated otherwise; errors are `application/problem+json`. */
  contentType?: string;
  headers?: readonly ResponseHeader[];
};

export type ApiOperation = {
  method: 'get' | 'post';
  /** OpenAPI path template, e.g. `/areas/{id}`. */
  path: string;
  operationId: string;
  tag: 'Locations' | 'Areas' | 'Logs' | 'Operations';
  summary: string;
  description?: string;
  /** Reachable without an API key. */
  public?: boolean;
  body?: z.ZodType;
  query?: z.ZodType;
  params?: z.ZodType;
  /** Optional `Idempotency-Key` request header. */
  idempotencyKey?: boolean;
  responses: Readonly<Record<number, ApiResponse>>;
};

const PROBLEM = 'application/problem+json';

function problem(description: string, headers?: readonly ResponseHeader[]): ApiResponse {
  return { description, schema: problemSchema, contentType: PROBLEM, headers };
}

const invalid = problem('The request is invalid; `errors` lists every offending field');
const unauthorized = problem('The x-api-key header is missing or wrong');
const databaseUnavailable = problem('The database is unavailable; retry later', ['retry-after']);

/**
 * Every HTTP operation of the API role, with the schemas its handlers validate with. The OpenAPI
 * document is generated from this table, and the contract test checks the running application against
 * it: every route is listed, and real responses match the listed schemas.
 */
export function apiOperations(limits: AreaLimits): ApiOperation[] {
  return [
    {
      method: 'post',
      path: '/locations',
      operationId: 'acceptPing',
      tag: 'Locations',
      summary: 'Accept a location ping',
      description:
        'Writes the ping to Kafka and answers once it is acknowledged; entries into areas are detected ' +
        'asynchronously and appear in `GET /logs` shortly after. Limited per user.',
      body: locationPingSchema,
      responses: {
        202: { description: 'The ping is durably queued', schema: acceptedPingSchema },
        400: invalid,
        401: unauthorized,
        429: problem('Too many pings for this user; retry after the given time', ['retry-after']),
        503: problem('Ingestion is temporarily unavailable; retry or drop the ping', [
          'retry-after',
        ]),
      },
    },
    {
      method: 'post',
      path: '/areas',
      operationId: 'createArea',
      tag: 'Areas',
      summary: 'Create an area',
      description:
        'The polygon must be valid (no self-intersection) and is stored with a counterclockwise ' +
        'exterior ring. Names are unique regardless of case.',
      body: createAreaSchema(limits),
      idempotencyKey: true,
      responses: {
        201: {
          description:
            'The area was created, or the original response is replayed for a repeated Idempotency-Key',
          schema: areaSchema,
          headers: ['location', 'idempotent-replayed'],
        },
        400: invalid,
        401: unauthorized,
        409: problem('An area with this name already exists'),
        422: problem('The Idempotency-Key was already used with a different body'),
        503: databaseUnavailable,
      },
    },
    {
      method: 'get',
      path: '/areas',
      operationId: 'listAreas',
      tag: 'Areas',
      summary: 'List areas, newest first',
      query: listAreasQuerySchema,
      responses: {
        200: { description: 'One page of areas', schema: pageSchema(areaSchema) },
        400: invalid,
        401: unauthorized,
        503: databaseUnavailable,
      },
    },
    {
      method: 'get',
      path: '/areas/{id}',
      operationId: 'getArea',
      tag: 'Areas',
      summary: 'Get an area',
      params: areaIdParamsSchema,
      responses: {
        200: { description: 'The area', schema: areaSchema },
        400: invalid,
        401: unauthorized,
        404: problem('No area has this id'),
        503: databaseUnavailable,
      },
    },
    {
      method: 'get',
      path: '/logs',
      operationId: 'listLogs',
      tag: 'Logs',
      summary: 'List entries into areas, newest first',
      description:
        'Filters combine with AND. `from` is inclusive and `to` exclusive, both on `enteredAt`; ' +
        'encode `+` in offsets as `%2B`. A cursor is only valid with the filters it was issued for.',
      query: listLogsQuerySchema,
      responses: {
        200: { description: 'One page of entries', schema: pageSchema(areaEntrySchema) },
        400: invalid,
        401: unauthorized,
        503: databaseUnavailable,
      },
    },
    {
      method: 'get',
      path: '/health/live',
      operationId: 'liveness',
      tag: 'Operations',
      summary: 'Liveness probe',
      description: 'Answers while the event loop responds; checks no dependency.',
      public: true,
      responses: { 200: { description: 'The process is alive', schema: livenessSchema } },
    },
    {
      method: 'get',
      path: '/health/ready',
      operationId: 'readiness',
      tag: 'Operations',
      summary: 'Readiness probe',
      description: 'Not ready while starting or draining. Dependencies are reported only.',
      public: true,
      responses: {
        200: { description: 'The process should receive traffic', schema: readinessSchema },
        503: { description: 'The process is starting or draining', schema: readinessSchema },
      },
    },
    {
      method: 'get',
      path: '/metrics',
      operationId: 'metrics',
      tag: 'Operations',
      summary: 'Prometheus metrics',
      public: true,
      responses: {
        200: {
          description: 'Metrics of this process',
          schema: metricsSchema,
          contentType: 'text/plain',
        },
      },
    },
  ];
}
