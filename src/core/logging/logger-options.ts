import { hostname } from 'node:os';
import { type LoggerOptions, stdTimeFunctions } from 'pino';
import type { Env } from '../config/env.schema.js';

export type LoggingEnv = Pick<Env, 'SERVICE_NAME' | 'LOG_LEVEL' | 'LOG_FORMAT'>;

/**
 * Header values that must never reach a log sink, even if some code logs a full request.
 */
const REDACTED_PATHS = [
  'req.headers["x-api-key"]',
  'req.headers.authorization',
  'req.headers.cookie',
  'headers["x-api-key"]',
  'headers.authorization',
];

/**
 * Base pino configuration shared by the HTTP logger, the worker and standalone scripts:
 * one JSON object per line on stdout, ISO timestamps, textual levels and service metadata.
 * `LOG_FORMAT=pretty` switches to human-readable output for local development only.
 */
export function createLoggerOptions(env: LoggingEnv, role: string): LoggerOptions {
  return {
    level: env.LOG_LEVEL,
    base: { service: env.SERVICE_NAME, role, pid: process.pid, hostname: hostname() },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    redact: { paths: REDACTED_PATHS, censor: '[REDACTED]' },
    ...(env.LOG_FORMAT === 'pretty'
      ? {
          transport: {
            target: 'pino-pretty',
            options: {
              singleLine: true,
              translateTime: 'SYS:HH:MM:ss.l',
              ignore: 'pid,hostname,service',
            },
          },
        }
      : {}),
  };
}
