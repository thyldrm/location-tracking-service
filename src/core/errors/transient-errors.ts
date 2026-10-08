import { QueryFailedError } from 'typeorm';

/** PostgreSQL SQLSTATE codes that mean "the database is unavailable or overloaded, try again". */
const TRANSIENT_DATABASE_CODES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '53300', // too_many_connections
  '57014', // query_canceled (statement_timeout)
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '08000', // connection_exception
  '08001', // sqlclient_unable_to_establish_sqlconnection
  '08003', // connection_does_not_exist
  '08006', // connection_failure
]);

/** Node.js socket error codes raised when a dependency cannot be reached. */
const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EPIPE',
  'EAI_AGAIN',
]);

/**
 * Failures of the `pg` driver that carry no code, only a message. Observed by stopping the database
 * ("Connection terminated unexpectedly") and by freezing it so that the client-side `query_timeout`
 * fires ("Query read timeout").
 */
const TRANSIENT_DRIVER_MESSAGES = [
  /^Connection terminated/,
  /^Query read timeout$/,
  /timeout exceeded when trying to connect/,
  /^Client has encountered a connection error/,
];

function stringProperty(value: unknown, name: string): string | undefined {
  if (typeof value === 'object' && value !== null && name in value) {
    const property: unknown = Reflect.get(value, name);
    return typeof property === 'string' ? property : undefined;
  }
  return undefined;
}

/**
 * Whether `error` means "a dependency is unavailable or overloaded right now": retrying the same work
 * later can succeed. The API answers such errors with 503 + Retry-After; the worker retries them with
 * back-off instead of giving up on the message.
 */
export function isTransientError(error: unknown): boolean {
  const cause = error instanceof QueryFailedError ? error.driverError : error;
  const code = stringProperty(cause, 'code') ?? stringProperty(error, 'code');
  if (code && (TRANSIENT_DATABASE_CODES.has(code) || NETWORK_ERROR_CODES.has(code))) {
    return true;
  }
  const message = stringProperty(error, 'message') ?? '';
  return TRANSIENT_DRIVER_MESSAGES.some((pattern) => pattern.test(message));
}
