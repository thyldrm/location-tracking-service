import { loadEnv } from './load-env.js';

describe('loadEnv', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('points developers to .env.example when the .env file is missing', () => {
    vi.stubEnv('POSTGRES_USER', undefined);

    expect(() => loadEnv('missing.env')).toThrowError(/copy \.env\.example to \.env/);
  });

  it('reads variables from the real environment when no .env file exists', () => {
    vi.stubEnv('POSTGRES_USER', 'location');
    vi.stubEnv('POSTGRES_PASSWORD', 'secret');
    vi.stubEnv('POSTGRES_DB', 'location_tracking');

    expect(loadEnv('missing.env').POSTGRES_DB).toBe('location_tracking');
  });
});
