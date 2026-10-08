import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { parseOrThrow } from '../../core/validation/zod-validation.pipe.js';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

/** Visible ASCII only: the key is stored and may be logged, so control characters are rejected. */
const idempotencyKeySchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[\x21-\x7E]+$/, 'must contain visible ASCII characters only')
  .optional();

/** Validates the raw header value (a repeated header arrives as an array and is rejected). */
export function parseIdempotencyKey(value: unknown): string | undefined {
  return parseOrThrow(
    z.object({ [IDEMPOTENCY_KEY_HEADER]: idempotencyKeySchema }),
    { [IDEMPOTENCY_KEY_HEADER]: value },
    'Request headers are invalid.',
  )[IDEMPOTENCY_KEY_HEADER];
}

/** Injects the validated `Idempotency-Key` header, or `undefined` when the client did not send one. */
export const IdempotencyKey = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined =>
    parseIdempotencyKey(
      context.switchToHttp().getRequest<FastifyRequest>().headers[IDEMPOTENCY_KEY_HEADER],
    ),
);
