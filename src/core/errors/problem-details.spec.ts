import {
  BadRequestException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { QueryFailedError } from 'typeorm';
import {
  ConflictError,
  NotFoundError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from './app-errors.js';
import { PROBLEM_TYPE_BASE, resolveProblem } from './problem-details.js';

function databaseError(code: string, constraint?: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT ...',
    [],
    Object.assign(new Error('db'), { code, constraint }),
  );
}

describe('resolveProblem', () => {
  describe('application errors', () => {
    it('renders the error as a typed problem document', () => {
      const { problem, expected } = resolveProblem(new NotFoundError('Area 42 does not exist.'));

      expect(problem).toEqual({
        type: `${PROBLEM_TYPE_BASE}not-found`,
        title: 'Resource not found',
        status: 404,
        detail: 'Area 42 does not exist.',
      });
      expect(expected).toBe(true);
    });

    it('adds field errors of a validation failure as an extension member', () => {
      const error = new ValidationError('Request body is invalid.', [
        { path: 'latitude', message: 'Must be at most 90' },
      ]);

      expect(resolveProblem(error).problem).toMatchObject({
        status: 400,
        errors: [{ path: 'latitude', message: 'Must be at most 90' }],
      });
    });

    it('sets Retry-After for rate limiting and unavailability', () => {
      expect(resolveProblem(new TooManyRequestsError('Slow down.', 7)).headers).toEqual({
        'retry-after': '7',
      });
      expect(resolveProblem(new ServiceUnavailableError('Kafka is down.', 2))).toMatchObject({
        problem: { status: 503 },
        headers: { 'retry-after': '2' },
        // Raised on purpose: the outage is reported by the component that detected it.
        expected: true,
      });
    });

    it('tells the client how to authenticate on 401', () => {
      expect(resolveProblem(new UnauthorizedError('Missing key.')).headers).toHaveProperty(
        'www-authenticate',
      );
    });
  });

  describe('framework HTTP exceptions', () => {
    it('uses about:blank and the status phrase as title', () => {
      expect(resolveProblem(new NotFoundException('Cannot GET /nope')).problem).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Cannot GET /nope',
      });
    });

    it('joins multiple messages', () => {
      const exception = new BadRequestException(['first problem', 'second problem']);

      expect(resolveProblem(exception).problem.detail).toBe('first problem; second problem');
    });

    it('never forwards the message of a 5xx framework exception', () => {
      const { problem } = resolveProblem(new ServiceUnavailableException('internal host db-7'));

      expect(problem.status).toBe(500);
      expect(problem.detail).not.toContain('db-7');
    });
  });

  describe('database errors (safety net)', () => {
    it('maps a unique violation to 409', () => {
      expect(resolveProblem(databaseError('23505', 'uq_areas_name_lower')).problem.status).toBe(
        409,
      );
    });

    it('maps a foreign key violation to 409', () => {
      expect(resolveProblem(databaseError('23503')).problem.status).toBe(409);
    });

    it.each(['57014', '40001', '40P01', '53300', '57P01', '08006'])(
      'maps transient SQLSTATE %s to 503 with Retry-After',
      (code) => {
        expect(resolveProblem(databaseError(code))).toMatchObject({
          problem: { status: 503 },
          headers: { 'retry-after': '1' },
        });
      },
    );

    it('maps any other database error to an opaque 500', () => {
      expect(resolveProblem(databaseError('42P01')).problem.status).toBe(500);
    });
  });

  it('maps an unreachable dependency to 503', () => {
    const error = Object.assign(new Error('connect ECONNREFUSED 10.0.0.7:5432'), {
      code: 'ECONNREFUSED',
    });

    const { problem } = resolveProblem(error);

    expect(problem.status).toBe(503);
    expect(problem.detail).not.toContain('10.0.0.7');
  });

  it('passes through client errors raised by Fastify before routing', () => {
    const error = Object.assign(new Error('Request body is too large'), {
      statusCode: 413,
      code: 'FST_ERR_CTP_BODY_TOO_LARGE',
    });

    expect(resolveProblem(error).problem).toMatchObject({
      status: 413,
      title: 'Payload Too Large',
    });
  });

  it('answers a lost database connection with a retryable 503', () => {
    const { problem, headers } = resolveProblem(new Error('Connection terminated unexpectedly'));

    expect(problem.status).toBe(503);
    expect(headers).toEqual({ 'retry-after': '1' });
  });

  it('hides the details of unexpected errors', () => {
    const { problem, expected } = resolveProblem(new TypeError("Cannot read 'x' of undefined"));

    expect(problem).toMatchObject({ status: 500, title: 'Internal server error' });
    expect(problem.detail).not.toContain('undefined');
    expect(expected).toBe(false);
  });

  it('treats a non-Error throw as unexpected', () => {
    expect(resolveProblem('a string was thrown').problem.status).toBe(500);
    expect(resolveProblem(new ConflictError('x')).problem.status).toBe(409);
  });
});
