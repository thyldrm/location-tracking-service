import { STATUS_CODES } from 'node:http';
import { HttpException } from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import { AppError } from './app-errors.js';

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';

/** Namespace of the problem types this service defines (RFC 9457 §3.1.1). */
export const PROBLEM_TYPE_BASE = 'https://location-tracking-service/problems/';

/** RFC 9457 problem document. `instance` and `correlationId` are added per request by the filter. */
export type ProblemDetails = {
  type: string;
  title: string;
  status: number;
  detail: string;
  instance?: string;
  correlationId?: string;
  [extension: string]: unknown;
};

/**
 * How an exception is presented. `expected` is false for errors that point to a bug or an
 * infrastructure failure; those are logged at error level with their stack trace.
 */
export type ResolvedProblem = {
  problem: ProblemDetails;
  headers: Record<string, string>;
  expected: boolean;
};

const INTERNAL_ERROR: ResolvedProblem = {
  problem: {
    type: `${PROBLEM_TYPE_BASE}internal-error`,
    title: 'Internal server error',
    status: 500,
    // Deliberately generic: internal messages may reveal implementation details.
    detail: 'An unexpected error occurred. Use the correlationId when reporting the problem.',
  },
  headers: {},
  expected: false,
};

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
]);

function problem(
  slug: string,
  status: number,
  title: string,
  detail: string,
  options: { headers?: Record<string, string>; expected?: boolean } = {},
): ResolvedProblem {
  return {
    problem: { type: `${PROBLEM_TYPE_BASE}${slug}`, title, status, detail },
    headers: options.headers ?? {},
    expected: options.expected ?? true,
  };
}

function serviceUnavailable(detail: string): ResolvedProblem {
  return problem('service-unavailable', 503, 'Service unavailable', detail, {
    headers: { 'retry-after': '1' },
    expected: false,
  });
}

function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'string' ? code : undefined;
  }
  return undefined;
}

function fromHttpException(exception: HttpException): ResolvedProblem {
  const status = exception.getStatus();
  if (status >= 500) {
    return INTERNAL_ERROR;
  }
  const response = exception.getResponse();
  const message =
    typeof response === 'object' && response !== null && 'message' in response
      ? response.message
      : response;
  const detail = Array.isArray(message) ? message.join('; ') : String(message);
  return {
    // "about:blank" means: the HTTP status itself is the problem type (RFC 9457 §4.2.1).
    problem: { type: 'about:blank', title: STATUS_CODES[status] ?? 'Error', status, detail },
    headers: {},
    expected: true,
  };
}

/**
 * Database errors normally never reach this point: services translate the violations they expect
 * (for example a duplicate area name) into specific AppErrors. This is the safety net.
 */
function fromDatabaseError(exception: QueryFailedError): ResolvedProblem {
  const code = errorCode(exception.driverError);
  if (code && TRANSIENT_DATABASE_CODES.has(code)) {
    return serviceUnavailable('The database is temporarily unavailable. Retry the request.');
  }
  switch (code) {
    case '23505':
      return problem(
        'conflict',
        409,
        'Conflict',
        'The request conflicts with an existing resource.',
      );
    case '23503':
      return problem(
        'conflict',
        409,
        'Conflict',
        'The request references a resource that does not exist or is still in use.',
      );
    default:
      return INTERNAL_ERROR;
  }
}

/**
 * Errors raised by Fastify before the request reaches NestJS (malformed JSON, body too large,
 * unsupported media type) carry a 4xx `statusCode` and a client-safe message.
 */
function fromFrameworkClientError(exception: unknown): ResolvedProblem | undefined {
  if (!(exception instanceof Error) || !('statusCode' in exception)) {
    return undefined;
  }
  const { statusCode } = exception;
  if (typeof statusCode !== 'number' || statusCode < 400 || statusCode >= 500) {
    return undefined;
  }
  return {
    problem: {
      type: 'about:blank',
      title: STATUS_CODES[statusCode] ?? 'Error',
      status: statusCode,
      detail: exception.message,
    },
    headers: {},
    expected: true,
  };
}

/** Maps any thrown value to the problem document returned to the client. */
export function resolveProblem(exception: unknown): ResolvedProblem {
  if (exception instanceof AppError) {
    return {
      problem: {
        type: `${PROBLEM_TYPE_BASE}${exception.slug}`,
        title: exception.title,
        status: exception.status,
        detail: exception.detail,
        ...exception.extensions,
      },
      headers: exception.headers,
      expected: exception.expected,
    };
  }
  if (exception instanceof HttpException) {
    return fromHttpException(exception);
  }
  if (exception instanceof QueryFailedError) {
    return fromDatabaseError(exception);
  }
  const code = errorCode(exception);
  if (code && NETWORK_ERROR_CODES.has(code)) {
    return serviceUnavailable('A dependency of the service is unavailable. Retry the request.');
  }
  return fromFrameworkClientError(exception) ?? INTERNAL_ERROR;
}
