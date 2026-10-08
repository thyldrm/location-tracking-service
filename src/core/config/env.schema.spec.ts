import { validateEnv } from './env.schema.js';

const requiredVariables = {
  POSTGRES_USER: 'location',
  POSTGRES_PASSWORD: 'secret',
  POSTGRES_DB: 'location_tracking',
};

function captureError(fn: () => unknown): Error {
  try {
    fn();
  } catch (error) {
    if (error instanceof Error) return error;
  }
  throw new Error('Expected the function to throw an Error');
}

describe('validateEnv', () => {
  it('applies defaults when optional variables are missing', () => {
    const env = validateEnv(requiredVariables);

    expect(env.NODE_ENV).toBe('development');
    expect(env.HTTP_PORT).toBeUndefined(); // each process role falls back to its own default port
    expect(env.HTTP_TRUST_PROXY).toBe(false);
    expect(env.POSTGRES_PORT).toBe(5432);
    expect(env.DB_POOL_MAX).toBe(10);
  });

  it('coerces numeric and boolean strings into typed values', () => {
    const env = validateEnv({
      ...requiredVariables,
      HTTP_PORT: '8080',
      HTTP_TRUST_PROXY: 'true',
      POSTGRES_SSL: 'true',
    });

    expect(env.HTTP_PORT).toBe(8080);
    expect(env.HTTP_TRUST_PROXY).toBe(true);
    expect(env.POSTGRES_SSL).toBe(true);
  });

  it('requires database credentials instead of defaulting them', () => {
    const error = captureError(() => validateEnv({}));

    expect(error.message).toContain('at POSTGRES_USER');
    expect(error.message).toContain('at POSTGRES_PASSWORD');
    expect(error.message).toContain('at POSTGRES_DB');
  });

  it('parses API_KEYS as a trimmed, comma-separated list', () => {
    const first = 'a'.repeat(32);
    const second = 'b'.repeat(40);

    expect(
      validateEnv({ ...requiredVariables, API_KEYS: ` ${first} , ${second},` }).API_KEYS,
    ).toEqual([first, second]);
    expect(validateEnv(requiredVariables).API_KEYS).toEqual([]);
  });

  it('rejects API keys that are too short to be secret', () => {
    const error = captureError(() => validateEnv({ ...requiredVariables, API_KEYS: 'short-key' }));

    expect(error.message).toContain('at least 32 characters');
  });

  it('parses the Kafka broker list and requires at least one broker', () => {
    expect(validateEnv(requiredVariables).KAFKA_BROKERS).toEqual(['localhost:9092']);
    expect(
      validateEnv({ ...requiredVariables, KAFKA_BROKERS: 'kafka-1:9092, kafka-2:9092' })
        .KAFKA_BROKERS,
    ).toEqual(['kafka-1:9092', 'kafka-2:9092']);
    expect(() => validateEnv({ ...requiredVariables, KAFKA_BROKERS: ' , ' })).toThrow(
      /KAFKA_BROKERS/,
    );
  });

  it('accepts only redis:// and rediss:// URLs for Redis', () => {
    expect(validateEnv({ ...requiredVariables, REDIS_URL: 'rediss://cache:6380' }).REDIS_URL).toBe(
      'rediss://cache:6380',
    );
    expect(() => validateEnv({ ...requiredVariables, REDIS_URL: 'http://cache:6379' })).toThrow(
      /REDIS_URL/,
    );
  });

  it('requires the presence state to outlive a presence session', () => {
    expect(() =>
      validateEnv({
        ...requiredVariables,
        PRESENCE_TTL_MS: '900000',
        PRESENCE_STATE_TTL_MS: '600000',
      }),
    ).toThrow(/PRESENCE_STATE_TTL_MS/);
  });

  it('requires a broker acknowledgement to fit in an open transaction (outbox relay)', () => {
    expect(() =>
      validateEnv({
        ...requiredVariables,
        KAFKA_DELIVERY_TIMEOUT_MS: '10000',
        DB_IDLE_IN_TRANSACTION_TIMEOUT_MS: '10000',
      }),
    ).toThrow(/KAFKA_DELIVERY_TIMEOUT_MS/);
  });

  it('requires the drain delay to fit in the shutdown timeout', () => {
    expect(() =>
      validateEnv({
        ...requiredVariables,
        SHUTDOWN_DRAIN_DELAY_MS: '30000',
        SHUTDOWN_TIMEOUT_MS: '25000',
      }),
    ).toThrow(/SHUTDOWN_DRAIN_DELAY_MS/);
  });

  it('enables the API documentation by default except in production', () => {
    expect(validateEnv(requiredVariables).OPENAPI_ENABLED).toBe(true);
    expect(validateEnv({ ...requiredVariables, NODE_ENV: 'production' }).OPENAPI_ENABLED).toBe(
      false,
    );
    expect(
      validateEnv({ ...requiredVariables, NODE_ENV: 'production', OPENAPI_ENABLED: 'true' })
        .OPENAPI_ENABLED,
    ).toBe(true);
  });

  it('throws a readable error listing every invalid variable', () => {
    const error = captureError(() =>
      validateEnv({ ...requiredVariables, HTTP_PORT: 'not-a-port', LOG_LEVEL: 'verbose' }),
    );

    // The order of reported issues is not guaranteed, so assert on each one independently.
    expect(error.message).toMatch(/^Invalid environment configuration/);
    expect(error.message).toContain('at HTTP_PORT');
    expect(error.message).toContain('at LOG_LEVEL');
  });
});
