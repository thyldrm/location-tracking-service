import { QueryFailedError } from 'typeorm';

/** PostgreSQL SQLSTATE of a unique constraint violation. */
const UNIQUE_VIOLATION = '23505';

/**
 * True when `error` is a unique violation of the named constraint or index. Services use it to translate
 * a violation they expect (e.g. a duplicate area name) into a specific `AppError`. Matching on the
 * constraint name is why every constraint has an explicit, stable name.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError: unknown = error.driverError;
  return (
    typeof driverError === 'object' &&
    driverError !== null &&
    'code' in driverError &&
    driverError.code === UNIQUE_VIOLATION &&
    'constraint' in driverError &&
    driverError.constraint === constraint
  );
}
