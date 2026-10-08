import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { UnauthorizedError } from '../errors/app-errors.js';
import { ApiKeyVerifier } from './api-key-verifier.js';
import { IS_PUBLIC_KEY } from './public.decorator.js';

export const API_KEY_HEADER = 'x-api-key';

/**
 * Global guard of the API role: every route requires a valid `x-api-key` header unless it is
 * marked with `@Public()`.
 *
 * This is service-to-service protection. End-user authentication (JWT) is performed by the API
 * gateway in front of the service (see SPEC §3, assumption 2).
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: ApiKeyVerifier,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true;
    }

    const presented = context.switchToHttp().getRequest<FastifyRequest>().headers[API_KEY_HEADER];
    if (typeof presented !== 'string' || !this.verifier.isValid(presented)) {
      throw new UnauthorizedError(`A valid ${API_KEY_HEADER} header is required.`);
    }
    return true;
  }
}
