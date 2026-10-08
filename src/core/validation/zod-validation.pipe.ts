import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { type FieldError, ValidationError } from '../errors/app-errors.js';

const DETAIL_BY_SOURCE: Record<ArgumentMetadata['type'], string> = {
  body: 'Request body is invalid.',
  query: 'Query parameters are invalid.',
  param: 'Path parameters are invalid.',
  custom: 'Request is invalid.',
};

/** Converts Zod issues into the `errors` member of a validation problem. */
export function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.flatMap((issue) => {
    const path = issue.path.map(String);
    if (issue.code === 'unrecognized_keys') {
      // One error per unknown field, at the field's own path, like every other field error.
      return issue.keys.map((key) => ({
        path: [...path, key].join('.'),
        message: 'is not a recognised field',
      }));
    }
    return [{ path: path.join('.') || '(root)', message: issue.message }];
  });
}

/**
 * Parses `value` with `schema` and returns the typed, transformed result, or throws a
 * `ValidationError` that lists every offending field.
 */
export function parseOrThrow<T>(schema: z.ZodType<T>, value: unknown, detail: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(detail, toFieldErrors(result.error));
  }
  return result.data;
}

/**
 * Validates a route argument (`@Body()`, `@Query()`, `@Param()`) with a Zod schema. The handler receives
 * the parsed output, so it never sees unvalidated input:
 *
 * ```ts
 * create(@Body(new ZodValidationPipe(createAreaSchema)) body: CreateAreaInput)
 * ```
 */
export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: z.ZodType<T>) {}

  transform(value: unknown, metadata: ArgumentMetadata): T {
    return parseOrThrow(this.schema, value, DETAIL_BY_SOURCE[metadata.type]);
  }
}
