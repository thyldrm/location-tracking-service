import type { DestinationStream } from 'pino';

export type LogLine = Record<string, unknown> & { level: string; msg?: string };

/**
 * In-memory pino destination: every log line is parsed and kept so tests can assert on the logs
 * an application produced.
 */
export class LogCapture implements DestinationStream {
  readonly lines: LogLine[] = [];

  write(chunk: string): void {
    for (const line of chunk.split('\n')) {
      if (line.trim().length > 0) {
        this.lines.push(JSON.parse(line) as LogLine);
      }
    }
  }

  withCorrelationId(correlationId: string): LogLine[] {
    return this.lines.filter((line) => line.correlationId === correlationId);
  }

  clear(): void {
    this.lines.length = 0;
  }
}

/** pino-http writes the access log when the response stream finishes; give it a turn of the loop. */
export function flushLogs(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
