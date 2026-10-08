import { Injectable } from '@nestjs/common';

/**
 * Source of the current time. Business code depends on this abstraction instead of calling
 * `new Date()` directly, so tests can control time (e.g. "15 minutes later") deterministically.
 *
 * An abstract class (not an interface) is used because it exists at runtime and can therefore
 * serve as a dependency injection token.
 */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
