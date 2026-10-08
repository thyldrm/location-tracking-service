import { Injectable } from '@nestjs/common';
import { v7 as uuidv7 } from 'uuid';

/**
 * Generates identifiers for new records and events. Injected so that tests can use predictable ids.
 */
export abstract class IdGenerator {
  abstract next(): string;
}

/**
 * UUIDv7: the first 48 bits are a millisecond timestamp, so ids are time-ordered and append to the
 * right edge of B-tree indexes, while still being generated without coordination.
 */
@Injectable()
export class UuidV7Generator extends IdGenerator {
  next(): string {
    return uuidv7();
  }
}
