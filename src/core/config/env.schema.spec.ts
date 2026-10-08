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
    expect(env.HTTP_PORT).toBe(3000);
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
