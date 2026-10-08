import type { IncomingMessage, ServerResponse } from 'node:http';
import { type DynamicModule, Module } from '@nestjs/common';
import { LoggerModule } from 'nestjs-pino';
import type { DestinationStream } from 'pino';
import type { Options } from 'pino-http';
import { ensureCorrelationId } from '../context/correlation-id.js';
import { IdGenerator } from '../foundation/id-generator.js';
import { createLoggerOptions, type LoggingEnv } from './logger-options.js';

/** Probe and scrape endpoints are called every few seconds; logging them would drown real traffic. */
const OPERATIONAL_PATHS = new Set(['/health/live', '/health/ready', '/metrics']);

/**
 * Path of the request without the query string. Inside NestJS middleware on Fastify, `req.url` is
 * temporarily rewritten relative to the middleware mount point; the full URL is kept in `originalUrl`.
 */
function requestPath(request: IncomingMessage): string {
  const url =
    'originalUrl' in request && typeof request.originalUrl === 'string'
      ? request.originalUrl
      : (request.url ?? '');
  return url.split('?')[0] ?? '';
}

export type LoggingModuleOptions = {
  role: string;
  /** Overrides stdout; used by tests to capture log lines. */
  destination?: DestinationStream;
};

/**
 * Structured logging with pino. Every HTTP request gets a child logger bound to its correlation id,
 * so all log lines written while handling the request (including the access log) carry the same
 * `correlationId` field.
 */
@Module({})
export class LoggingModule {
  static forRoot(env: LoggingEnv, options: LoggingModuleOptions): DynamicModule {
    return {
      module: LoggingModule,
      imports: [
        LoggerModule.forRootAsync({
          inject: [IdGenerator],
          useFactory: (ids: IdGenerator) => {
            const httpOptions: Options = {
              ...createLoggerOptions(env, options.role),
              // Fastify normally assigns `req.id` already (see createFastifyAdapter) and pino-http
              // reuses it; this only applies if the server was created without that configuration.
              genReqId: (request) => ensureCorrelationId(request, () => ids.next()),
              customAttributeKeys: { reqId: 'correlationId' },
              // Request-scoped child loggers carry only the correlation id, not the whole request.
              quietReqLogger: true,
              autoLogging: { ignore: (request) => OPERATIONAL_PATHS.has(requestPath(request)) },
              customLogLevel: (_request, response, error) => {
                if (error || response.statusCode >= 500) return 'error';
                if (response.statusCode >= 400) return 'warn';
                return 'info';
              },
              customSuccessMessage: (request, response) =>
                `${request.method} ${request.url} ${response.statusCode}`,
              customErrorMessage: (request, response) =>
                `${request.method} ${request.url} ${response.statusCode}`,
              serializers: {
                req: (request: IncomingMessage) => ({ method: request.method, url: request.url }),
                res: (response: ServerResponse) => ({ statusCode: response.statusCode }),
              },
            };
            return {
              pinoHttp: options.destination ? [httpOptions, options.destination] : httpOptions,
            };
          },
        }),
      ],
    };
  }
}
