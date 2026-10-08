import { QueryFailedError } from 'typeorm';
import { isUniqueViolation } from './database-errors.js';

function databaseError(code: string, constraint?: string): QueryFailedError {
  return new QueryFailedError(
    'INSERT ...',
    [],
    Object.assign(new Error('db'), { code, constraint }),
  );
}

describe('isUniqueViolation', () => {
  it('matches a unique violation of the named constraint', () => {
    expect(
      isUniqueViolation(databaseError('23505', 'uq_areas_name_lower'), 'uq_areas_name_lower'),
    ).toBe(true);
  });

  it('does not match another constraint, another error code or a non-database error', () => {
    expect(isUniqueViolation(databaseError('23505', 'pk_areas'), 'uq_areas_name_lower')).toBe(
      false,
    );
    expect(
      isUniqueViolation(databaseError('23503', 'uq_areas_name_lower'), 'uq_areas_name_lower'),
    ).toBe(false);
    expect(isUniqueViolation(new Error('23505'), 'uq_areas_name_lower')).toBe(false);
  });
});
