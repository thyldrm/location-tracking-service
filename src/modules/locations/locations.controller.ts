import { Body, Controller, HttpCode, HttpStatus, Post } from '@nestjs/common';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { type LocationPingInput, locationPingSchema } from './location.schemas.js';
import { type AcceptedPing, LocationsService } from './locations.service.js';

@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  /**
   * 202 Accepted, not 201 Created: the ping is durably queued, but its effects (entries into areas)
   * are computed later by the worker.
   */
  @Post()
  @HttpCode(HttpStatus.ACCEPTED)
  accept(
    @Body(new ZodValidationPipe(locationPingSchema)) body: LocationPingInput,
  ): Promise<AcceptedPing> {
    return this.locations.accept(body);
  }
}
