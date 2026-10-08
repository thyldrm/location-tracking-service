import { createServer } from 'node:net';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { RedisContainer, type StartedRedisContainer } from '@testcontainers/redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { DataSource } from 'typeorm';
import type { TestProject } from 'vitest/node';
import { validateEnv } from '../../src/core/config/env.schema.js';
import { createDataSourceOptions } from '../../src/core/database/data-source-options.js';
import { provisionTopics } from '../../src/core/messaging/provision-topics.js';

/** Same images as docker-compose.yml, so tests run against the production engines. */
const POSTGIS_IMAGE = 'postgis/postgis:18-3.6-alpine';
const KAFKA_IMAGE = 'apache/kafka:4.3.1';
const REDIS_IMAGE = 'redis:8.8-alpine';

export type InfrastructureTestEnv = {
  POSTGRES_HOST: string;
  POSTGRES_PORT: string;
  POSTGRES_USER: string;
  POSTGRES_PASSWORD: string;
  POSTGRES_DB: string;
  KAFKA_BROKERS: string;
  REDIS_URL: string;
};

declare module 'vitest' {
  export interface ProvidedContext {
    infrastructureEnv: InfrastructureTestEnv;
  }
}

/** A TCP port that is free on this machine right now. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, () => {
      const address = server.address();
      server.close(() => {
        if (typeof address === 'object' && address !== null) resolve(address.port);
        else reject(new Error('Could not determine a free port'));
      });
    });
  });
}

/**
 * Single-node KRaft broker. A Kafka client first asks the bootstrap server for the cluster's brokers and
 * then connects to the *advertised* address, so that address must be reachable from the host: the
 * listener uses the same port inside and outside the container, chosen before the container starts.
 */
async function startKafka(): Promise<{ container: StartedTestContainer; brokers: string }> {
  const port = await freePort();
  const container = await new GenericContainer(KAFKA_IMAGE)
    .withExposedPorts({ container: port, host: port })
    .withEnvironment({
      KAFKA_NODE_ID: '1',
      KAFKA_PROCESS_ROLES: 'broker,controller',
      KAFKA_CONTROLLER_QUORUM_VOTERS: '1@localhost:9093',
      KAFKA_CONTROLLER_LISTENER_NAMES: 'CONTROLLER',
      KAFKA_LISTENERS: `PLAINTEXT://:${port},CONTROLLER://:9093`,
      KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://localhost:${port}`,
      KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT,CONTROLLER:PLAINTEXT',
      KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
      KAFKA_AUTO_CREATE_TOPICS_ENABLE: 'false',
      KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_REPLICATION_FACTOR: '1',
      KAFKA_TRANSACTION_STATE_LOG_MIN_ISR: '1',
      KAFKA_GROUP_INITIAL_REBALANCE_DELAY_MS: '0',
    })
    .withWaitStrategy(Wait.forLogMessage(/Kafka Server started/))
    .withStartupTimeout(120_000)
    .start();
  return { container, brokers: `localhost:${port}` };
}

const quietLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

/**
 * Starts the infrastructure once for the whole integration run (in parallel), applies the migrations,
 * creates the Kafka topics and hands the connection details to the test files through
 * `inject('infrastructureEnv')`.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const [postgres, kafka, redis]: [
    StartedPostgreSqlContainer,
    Awaited<ReturnType<typeof startKafka>>,
    StartedRedisContainer,
  ] = await Promise.all([
    new PostgreSqlContainer(POSTGIS_IMAGE)
      .withDatabase('location_tracking_test')
      .withUsername('test')
      .withPassword('test')
      .start(),
    startKafka(),
    new RedisContainer(REDIS_IMAGE).start(),
  ]);

  const infrastructureEnv: InfrastructureTestEnv = {
    POSTGRES_HOST: postgres.getHost(),
    POSTGRES_PORT: String(postgres.getPort()),
    POSTGRES_USER: postgres.getUsername(),
    POSTGRES_PASSWORD: postgres.getPassword(),
    POSTGRES_DB: postgres.getDatabase(),
    KAFKA_BROKERS: kafka.brokers,
    REDIS_URL: redis.getConnectionUrl(),
  };
  const env = validateEnv({ NODE_ENV: 'test', ...infrastructureEnv });

  const dataSource = new DataSource(createDataSourceOptions(env));
  await dataSource.initialize();
  await dataSource.runMigrations({ transaction: 'each' });
  await dataSource.destroy();

  await provisionTopics(env, quietLogger);

  project.provide('infrastructureEnv', infrastructureEnv);

  return async () => {
    await Promise.all([postgres.stop(), kafka.container.stop(), redis.stop()]);
  };
}
