import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UnauthorizedError } from '../errors/app-errors.js';
import { ApiKeyGuard } from './api-key.guard.js';
import { ApiKeyVerifier } from './api-key-verifier.js';

const VALID_KEY = 'valid-key-0123456789abcdef0123456789abc';

function contextWith(headers: Record<string, unknown>): ExecutionContext {
  return {
    getHandler: () => () => undefined,
    getClass: () => ApiKeyGuard,
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  } as unknown as ExecutionContext;
}

describe('ApiKeyGuard', () => {
  const reflector = new Reflector();
  const guard = new ApiKeyGuard(reflector, new ApiKeyVerifier([VALID_KEY]));

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lets a request with a valid key through', () => {
    expect(guard.canActivate(contextWith({ 'x-api-key': VALID_KEY }))).toBe(true);
  });

  it.each([
    ['missing', {}],
    ['wrong', { 'x-api-key': 'wrong-key' }],
    ['sent twice', { 'x-api-key': [VALID_KEY, VALID_KEY] }],
  ])('rejects a request whose key is %s', (_case, headers) => {
    expect(() => guard.canActivate(contextWith(headers))).toThrowError(UnauthorizedError);
  });

  it('lets public routes through without a key', () => {
    vi.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);

    expect(guard.canActivate(contextWith({}))).toBe(true);
  });
});
