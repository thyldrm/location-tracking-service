import { validateEnv } from './env.schema.js';

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
    const env = validateEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.HTTP_PORT).toBe(3000);
    expect(env.HTTP_TRUST_PROXY).toBe(false);
  });

  it('coerces numeric and boolean strings into typed values', () => {
    const env = validateEnv({ HTTP_PORT: '8080', HTTP_TRUST_PROXY: 'true' });

    expect(env.HTTP_PORT).toBe(8080);
    expect(env.HTTP_TRUST_PROXY).toBe(true);
  });

  it('throws a readable error listing every invalid variable', () => {
    const error = captureError(() =>
      validateEnv({ HTTP_PORT: 'not-a-port', LOG_LEVEL: 'verbose' }),
    );

    // The order of reported issues is not guaranteed, so assert on each one independently.
    expect(error.message).toMatch(/^Invalid environment configuration/);
    expect(error.message).toContain('at HTTP_PORT');
    expect(error.message).toContain('at LOG_LEVEL');
  });
});
