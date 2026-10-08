import { z } from 'zod';
import { ValidationError } from '../errors/app-errors.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

/** Returns what `work` throws, so assertions run unconditionally. */
function catchError(work: () => unknown): unknown {
  try {
    work();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the call to throw');
}

const schema = z.object({
  name: z.string().trim().min(1),
  position: z.tuple([z.number().max(180), z.number().max(90)]),
});

describe('ZodValidationPipe', () => {
  const pipe = new ZodValidationPipe(schema);

  it('returns the parsed and transformed value', () => {
    expect(pipe.transform({ name: '  Kadikoy ', position: [29, 41] }, { type: 'body' })).toEqual({
      name: 'Kadikoy',
      position: [29, 41],
    });
  });

  it('throws a validation error that lists every offending field by path', () => {
    const thrown = catchError(() =>
      pipe.transform({ name: '', position: [200, 41] }, { type: 'body' }),
    );

    expect(thrown).toBeInstanceOf(ValidationError);
    const error = thrown as ValidationError;
    expect(error.detail).toBe('Request body is invalid.');
    expect(error.errors.map((fieldError) => fieldError.path).toSorted()).toEqual([
      'name',
      'position.0',
    ]);
  });

  it('names the request part that failed', () => {
    expect(() => pipe.transform({}, { type: 'query' })).toThrow('Query parameters are invalid.');
  });

  it('reports every unknown field of a strict schema at its own path', () => {
    const strict = new ZodValidationPipe(z.strictObject({ limit: z.number().optional() }));

    const error = catchError(() =>
      strict.transform({ userID: 'u1', sort: 'x' }, { type: 'query' }),
    );

    expect((error as ValidationError).errors).toEqual([
      { path: 'userID', message: 'is not a recognised field' },
      { path: 'sort', message: 'is not a recognised field' },
    ]);
  });

  it('reports a wrong top-level type at the root path', () => {
    const error = catchError(() => pipe.transform(undefined, { type: 'body' }));

    expect((error as ValidationError).errors[0]?.path).toBe('(root)');
  });
});
