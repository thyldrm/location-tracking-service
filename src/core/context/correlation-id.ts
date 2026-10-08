import type { IncomingMessage } from 'node:http';

/** Header that carries the correlation id in requests, responses and message headers. */
export const CORRELATION_ID_HEADER = 'x-request-id';

/**
 * Incoming ids are echoed into logs and responses, so only a conservative character set is accepted.
 * Anything else (control characters, very long values, repeated headers) is replaced, which prevents
 * log injection and keeps ids usable as message headers.
 */
const SAFE_CORRELATION_ID = /^[A-Za-z0-9._:-]{1,128}$/;

export function isValidCorrelationId(value: unknown): value is string {
  return typeof value === 'string' && SAFE_CORRELATION_ID.test(value);
}

/**
 * Returns the request's correlation id, creating one when the client did not send a valid one.
 *
 * The resolved id is written back to the request headers, so every component that reads the request
 * afterwards (the context middleware, the HTTP logger) sees the same value regardless of the order
 * in which they run.
 */
export function ensureCorrelationId(request: IncomingMessage, generate: () => string): string {
  const incoming = request.headers[CORRELATION_ID_HEADER];
  if (isValidCorrelationId(incoming)) {
    return incoming;
  }
  const generated = generate();
  request.headers[CORRELATION_ID_HEADER] = generated;
  return generated;
}
