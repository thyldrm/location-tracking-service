import kafkaJavascript from '@confluentinc/kafka-javascript';
import type { KafkaJS } from '@confluentinc/kafka-javascript';
import type { Env } from '../config/env.schema.js';

/**
 * The Confluent client is a binding to librdkafka, the C library behind most Kafka clients (Python, Go,
 * .NET). Its `KafkaJS` namespace offers a promise-based API; librdkafka properties passed next to the
 * `kafkaJS` block take precedence over the defaults that block implies.
 */
export const { KafkaJS: Kafka } = kafkaJavascript;
export const KafkaErrorCodes = Kafka.ErrorCodes;

export type KafkaEnv = Pick<Env, 'KAFKA_BROKERS' | 'SERVICE_NAME'>;

/** The part of a pino logger (or of nestjs-pino's `PinoLogger`) the Kafka client needs. */
export type StructuredLogger = Record<
  'debug' | 'info' | 'warn' | 'error',
  (fields: object, message: string) => void
>;

/** Routes the client's log lines to pino instead of `console`. */
function kafkaLogger(logger: StructuredLogger): KafkaJS.Logger {
  const adapter: KafkaJS.Logger = {
    info: (message, extra) => logger.info({ kafka: extra }, message),
    warn: (message, extra) => logger.warn({ kafka: extra }, message),
    error: (message, extra) => logger.error({ kafka: extra }, message),
    debug: (message, extra) => logger.debug({ kafka: extra }, message),
    namespace: () => adapter,
    setLogLevel: () => undefined,
  };
  return adapter;
}

export function createKafka(env: KafkaEnv, logger: StructuredLogger): KafkaJS.Kafka {
  return new Kafka.Kafka({
    kafkaJS: {
      brokers: env.KAFKA_BROKERS,
      clientId: env.SERVICE_NAME,
      logger: kafkaLogger(logger),
      logLevel: Kafka.logLevel.WARN,
    },
  });
}

/** librdkafka's numeric error code of a client error, if any. */
export function kafkaErrorCode(error: unknown): number | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const { code } = error;
    return typeof code === 'number' ? code : undefined;
  }
  return undefined;
}
