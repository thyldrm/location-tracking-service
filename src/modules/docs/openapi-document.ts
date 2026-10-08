import { z } from 'zod';
import { CORRELATION_ID_HEADER } from '../../core/context/correlation-id.js';
import type { ApiOperation, ApiResponse, ResponseHeader } from './api-operations.js';

type JsonSchema = Record<string, unknown>;

/**
 * Zod schema → JSON Schema (draft 2020-12, the dialect of OpenAPI 3.1).
 *
 * Request schemas are converted as their input (what a client sends: a timestamp is a string, before it
 * becomes a Date). Formats such as `date-time` and `uuid` replace the long regular expressions Zod adds
 * for them. Refinements (e.g. a closed ring) cannot be expressed and are described in prose instead.
 */
function jsonSchema(schema: z.ZodType, io: 'input' | 'output'): JsonSchema {
  const { $schema: _dialect, ...converted } = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    unrepresentable: 'any',
    override: ({ jsonSchema: node }) => {
      if (typeof node.format === 'string') delete node.pattern;
    },
  });
  return converted;
}

function isObject(value: unknown): value is JsonSchema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `{ type: 'object', properties, required }` → one OpenAPI parameter per property. */
function parameters(schema: z.ZodType, location: 'query' | 'path'): JsonSchema[] {
  const converted = jsonSchema(schema, 'input');
  const properties = isObject(converted.properties) ? converted.properties : {};
  const required = new Set(Array.isArray(converted.required) ? converted.required : []);
  return Object.entries(properties).map(([name, property]) => {
    const { description, ...propertySchema } = isObject(property) ? property : {};
    return {
      name,
      in: location,
      required: location === 'path' || required.has(name),
      ...(description === undefined ? {} : { description }),
      schema: propertySchema,
    };
  });
}

const HEADERS: Record<ResponseHeader | typeof CORRELATION_ID_HEADER, JsonSchema> = {
  [CORRELATION_ID_HEADER]: {
    description:
      'Correlation id of the request: the one the caller sent if valid, otherwise a new one',
    required: true,
    schema: { type: 'string' },
  },
  location: {
    description: 'Path of the created resource',
    required: true,
    schema: { type: 'string' },
  },
  'idempotent-replayed': {
    description: '`true` when the response replays an earlier request with the same key',
    required: false,
    schema: { type: 'string', enum: ['true'] },
  },
  'retry-after': {
    description: 'Seconds to wait before retrying',
    required: true,
    schema: { type: 'integer' },
  },
};

function response(definition: ApiResponse): JsonSchema {
  const headers = [CORRELATION_ID_HEADER, ...(definition.headers ?? [])];
  return {
    description: definition.description,
    headers: Object.fromEntries(
      headers.map((name) => [name, { $ref: `#/components/headers/${name}` }]),
    ),
    content: {
      [definition.contentType ?? 'application/json']: {
        schema: jsonSchema(definition.schema, 'output'),
      },
    },
  };
}

function operation(definition: ApiOperation): JsonSchema {
  const parameterList = [
    ...(definition.params ? parameters(definition.params, 'path') : []),
    ...(definition.query ? parameters(definition.query, 'query') : []),
    ...(definition.idempotencyKey ? [{ $ref: '#/components/parameters/IdempotencyKey' }] : []),
  ];
  return {
    operationId: definition.operationId,
    tags: [definition.tag],
    summary: definition.summary,
    ...(definition.description === undefined ? {} : { description: definition.description }),
    ...(definition.public ? { security: [] } : {}),
    ...(parameterList.length > 0 ? { parameters: parameterList } : {}),
    ...(definition.body
      ? {
          requestBody: {
            required: true,
            content: { 'application/json': { schema: jsonSchema(definition.body, 'input') } },
          },
        }
      : {}),
    responses: Object.fromEntries(
      Object.entries(definition.responses).map(([status, definitionOfStatus]) => [
        status,
        response(definitionOfStatus),
      ]),
    ),
  };
}

/** OpenAPI 3.1 document of the API role, generated from the schemas the handlers validate with. */
export function buildOpenApiDocument(operations: readonly ApiOperation[]): JsonSchema {
  const paths: Record<string, Record<string, JsonSchema>> = {};
  for (const definition of operations) {
    paths[definition.path] = {
      ...paths[definition.path],
      [definition.method]: operation(definition),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Location Tracking Service',
      version: '1.0.0',
      description:
        'Ingests location pings, detects entries into polygonal areas and records them. ' +
        'Errors are RFC 9457 problem documents. The full specification is SPEC.md in the repository.',
    },
    // Relative: the API is served where the document is (the gateway may add a prefix).
    servers: [{ url: '/' }],
    tags: [
      { name: 'Locations', description: 'Ingestion of location pings' },
      { name: 'Areas', description: 'Polygonal areas' },
      { name: 'Logs', description: 'Recorded entries into areas' },
      { name: 'Operations', description: 'Probes and metrics; no API key' },
    ],
    security: [{ apiKey: [] }],
    paths,
    components: {
      securitySchemes: {
        apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
      },
      parameters: {
        IdempotencyKey: {
          name: 'Idempotency-Key',
          in: 'header',
          required: false,
          description:
            'Makes a retried request safe: the same key with the same body replays the original ' +
            'response; with a different body it is rejected. Kept for 24 h.',
          schema: { type: 'string', minLength: 1, maxLength: 128 },
        },
      },
      headers: HEADERS,
    },
  };
}
