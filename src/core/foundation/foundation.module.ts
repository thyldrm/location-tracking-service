import { Global, Module } from '@nestjs/common';
import { Clock, SystemClock } from './clock.js';
import { IdGenerator, UuidV7Generator } from './id-generator.js';

/**
 * Process-wide primitives (time and identifiers) that every module may depend on.
 */
@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    { provide: IdGenerator, useClass: UuidV7Generator },
  ],
  exports: [Clock, IdGenerator],
})
export class FoundationModule {}
