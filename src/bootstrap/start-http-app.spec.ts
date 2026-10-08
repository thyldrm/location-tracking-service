import { resolveHttpPort } from './start-http-app.js';

describe('resolveHttpPort', () => {
  it('gives each role its own default so both can run on one machine', () => {
    expect(resolveHttpPort('api', {})).toBe(3000);
    expect(resolveHttpPort('worker', {})).toBe(3001);
  });

  it('prefers an explicitly configured port', () => {
    expect(resolveHttpPort('worker', { HTTP_PORT: 8080 })).toBe(8080);
  });
});
