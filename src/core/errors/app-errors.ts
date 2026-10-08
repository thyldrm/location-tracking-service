/**
 * Errors that the service raises on purpose. Each one knows how it is presented to clients
 * (HTTP status, problem type and title), so business code can simply `throw new NotFoundError(...)`
 * and the global exception filter renders an RFC 9457 problem document.
 */

export type FieldError = { path: string; message: string };

export abstract class AppError extends Error {
  /** Last segment of the problem type URI, e.g. `not-found`. */
  abstract readonly slug: string;
  abstract readonly status: number;
  abstract readonly title: string;

  constructor(
    /** Human-readable explanation specific to this occurrence. Safe to show to clients. */
    readonly detail: string,
    options?: ErrorOptions,
  ) {
    super(detail, options);
    this.name = new.target.name;
  }

  /** Extra members added to the problem document (RFC 9457 "extension members"). */
  get extensions(): Record<string, unknown> {
    return {};
  }

  /** Extra response headers. */
  get headers(): Record<string, string> {
    return {};
  }

  /**
   * Whether this is an anticipated outcome rather than a bug. Expected errors are logged at debug level;
   * unexpected ones at error level with their stack trace.
   */
  get expected(): boolean {
    return this.status < 500;
  }
}

export class ValidationError extends AppError {
  readonly slug = 'validation-error';
  readonly status = 400;
  readonly title = 'Validation failed';

  constructor(
    detail: string,
    readonly errors: FieldError[] = [],
  ) {
    super(detail);
  }

  override get extensions(): Record<string, unknown> {
    return this.errors.length > 0 ? { errors: this.errors } : {};
  }
}

export class UnauthorizedError extends AppError {
  readonly slug = 'unauthorized';
  readonly status = 401;
  readonly title = 'Unauthorized';

  override get headers(): Record<string, string> {
    return { 'www-authenticate': 'ApiKey header="x-api-key"' };
  }
}

export class NotFoundError extends AppError {
  readonly slug = 'not-found';
  readonly status = 404;
  readonly title = 'Resource not found';
}

export class ConflictError extends AppError {
  readonly slug = 'conflict';
  readonly status = 409;
  readonly title = 'Conflict';
}

export class UnprocessableError extends AppError {
  readonly slug = 'unprocessable';
  readonly status = 422;
  readonly title = 'Unprocessable request';
}

abstract class RetryableError extends AppError {
  constructor(
    detail: string,
    readonly retryAfterSeconds: number,
    options?: ErrorOptions,
  ) {
    super(detail, options);
  }

  override get headers(): Record<string, string> {
    return { 'retry-after': String(this.retryAfterSeconds) };
  }

  /**
   * Raised on purpose when a dependency is down or a limit is reached: the cause is reported once by the
   * component that detected it, not once per rejected request (which would flood the logs in an outage).
   */
  override get expected(): boolean {
    return true;
  }
}

export class TooManyRequestsError extends RetryableError {
  readonly slug = 'rate-limited';
  readonly status = 429;
  readonly title = 'Too many requests';
}

export class ServiceUnavailableError extends RetryableError {
  readonly slug = 'service-unavailable';
  readonly status = 503;
  readonly title = 'Service unavailable';
}
