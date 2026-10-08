import { type Logger, pino, stdTimeFunctions } from 'pino';

/**
 * Logger for the moments before the configuration is loaded (or when loading it fails): it cannot
 * depend on the environment, but its output must still be one JSON object per line so that log
 * collectors parse startup failures like any other line.
 */
export function createBootstrapLogger(role: string): Logger {
  return pino({
    base: { service: 'location-tracking-service', role },
    timestamp: stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
  });
}
