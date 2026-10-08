import { setTimeout as sleep } from 'node:timers/promises';
import {
  type CanActivate,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { InjectPinoLogger, PinoLogger } from 'nestjs-pino';
import { DataSource } from 'typeorm';
import { ServiceUnavailableError } from '../errors/app-errors.js';
import { backoffDelayMs, withJitter } from '../foundation/backoff.js';

const RETRY = { baseMs: 1_000, maxMs: 15_000 };

/**
 * Connects to PostgreSQL without making the process depend on it at startup.
 *
 * The first attempt is awaited, so a process normally starts connected. If PostgreSQL is unreachable the
 * process starts anyway and keeps trying in the background: the API then accepts pings (which need only
 * Kafka) and answers the endpoints that need the database with 503 until it is connected; the worker's
 * loops wait for the connection (`whenConnected`). Once connected, an outage is handled by the
 * connection pool and surfaces as transient query errors.
 *
 * Until `DataSource.initialize()` has succeeded TypeORM has no entity metadata either, so a query would
 * fail with a misleading error: every user of the database must wait for, or check, the connection.
 */
@Injectable()
export class DatabaseConnection implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly connected = Promise.withResolvers<void>();
  private readonly stop = new AbortController();
  private connecting: Promise<void> | undefined;

  constructor(
    private readonly dataSource: DataSource,
    @InjectPinoLogger(DatabaseConnection.name) private readonly logger: PinoLogger,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (await this.attempt(1)) return;
    this.connecting = this.connectUntilStopped();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stop.abort();
    await this.connecting;
  }

  isConnected(): boolean {
    return this.dataSource.isInitialized;
  }

  /** Resolves once connected; rejects if the process shuts down first. */
  async whenConnected(signal: AbortSignal): Promise<void> {
    if (this.isConnected()) return;
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new Error('Stopped before the database was connected')),
        { once: true },
      );
    });
    await Promise.race([this.connected.promise, aborted]);
  }

  private async connectUntilStopped(): Promise<void> {
    for (let failures = 1; !this.stop.signal.aborted; failures++) {
      await sleep(withJitter(backoffDelayMs(failures, RETRY)), undefined, {
        signal: this.stop.signal,
      }).catch(() => undefined);
      if (this.stop.signal.aborted || (await this.attempt(failures + 1))) return;
    }
  }

  private async attempt(attempt: number): Promise<boolean> {
    try {
      await this.dataSource.initialize();
    } catch (error) {
      this.logger.error(
        { err: error, attempt },
        'Database unreachable; retrying in the background',
      );
      return false;
    }
    this.logger.info({ attempt }, 'Database connected');
    this.connected.resolve();
    return true;
  }
}

/**
 * For controllers whose endpoints need the database: answers 503 (with Retry-After) while the process
 * has not connected yet, instead of failing with TypeORM's "no metadata" error.
 */
@Injectable()
export class DatabaseConnectedGuard implements CanActivate {
  constructor(private readonly database: DatabaseConnection) {}

  canActivate(): boolean {
    if (!this.database.isConnected()) {
      throw new ServiceUnavailableError('The database is unavailable. Retry the request.', 5);
    }
    return true;
  }
}
