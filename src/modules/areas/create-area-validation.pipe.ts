import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema.js';
import { ZodValidationPipe } from '../../core/validation/zod-validation.pipe.js';
import { createAreaSchema, type CreateAreaInput } from './area.schemas.js';

/**
 * Body validation for `POST /areas`. The vertex limit comes from configuration, so this pipe is a
 * provider: passing the class to `@Body()` lets Nest construct it with its dependencies injected.
 */
@Injectable()
export class CreateAreaValidationPipe extends ZodValidationPipe<CreateAreaInput> {
  constructor(config: ConfigService<Env, true>) {
    super(createAreaSchema({ maxVertices: config.get('AREA_MAX_VERTICES', { infer: true }) }));
  }
}
