import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC_KEY = 'isPublic';

/**
 * Marks a controller or route as reachable without an API key (health probes, metrics, API docs).
 * Everything else is protected by default: forgetting a decorator fails closed, not open.
 */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);
