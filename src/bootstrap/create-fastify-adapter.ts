import type { IncomingMessage } from 'node:http';
import { FastifyAdapter } from '@nestjs/platform-fastify';
import type { Env } from '../core/config/env.schema.js';
import { ensureCorrelationId } from '../core/context/correlation-id.js';
import { UuidV7Generator } from '../core/foundation/id-generator.js';

/**
 * The HTTP server configuration shared by both roles and by the end-to-end tests.
 *
 * Fastify assigns every request an id before anything else runs, and that id is propagated to the
 * request context and to the HTTP logger. Generating it with `ensureCorrelationId` makes Fastify's
 * request id, the logged `correlationId` and the `x-request-id` response header one and the same value.
 */
export function createFastifyAdapter(
  env: Pick<Env, 'HTTP_BODY_LIMIT_BYTES' | 'HTTP_TRUST_PROXY'>,
): FastifyAdapter {
  // The DI container does not exist yet at this point; this is the composition root.
  const ids = new UuidV7Generator();
  return new FastifyAdapter({
    bodyLimit: env.HTTP_BODY_LIMIT_BYTES,
    trustProxy: env.HTTP_TRUST_PROXY,
    // Incoming ids are validated by `ensureCorrelationId`, never trusted blindly.
    requestIdHeader: false,
    genReqId: (request: IncomingMessage) => ensureCorrelationId(request, () => ids.next()),
  });
}
