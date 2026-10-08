import { QueryFailedError } from 'typeorm';
import { isTransientError } from './transient-errors.js';

function databaseError(code: string): QueryFailedError {
  return new QueryFailedError('SELECT 1', [], Object.assign(new Error('db'), { code }));
}

describe('isTransientError', () => {
  it.each([
    ['a statement timeout', databaseError('57014')],
    ['a serialization failure', databaseError('40001')],
    ['too many connections', databaseError('53300')],
    [
      'a refused connection',
      Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    ],
    // Observed when the database is stopped while the pool holds connections.
    ['a terminated connection', new Error('Connection terminated unexpectedly')],
    // Observed when the database stops answering and the client-side query_timeout fires.
    [
      'a client-side query timeout',
      new QueryFailedError('SELECT 1', [], new Error('Query read timeout')),
    ],
    ['a pool connect timeout', new Error('timeout exceeded when trying to connect')],
  ])('recognises %s', (_label, error) => {
    expect(isTransientError(error)).toBe(true);
  });

  it.each([
    ['a unique violation', databaseError('23505')],
    ['a check violation', databaseError('23514')],
    ['a programming error', new TypeError("Cannot read properties of undefined (reading 'id')")],
    ['a non-error value', 'boom'],
  ])('does not treat %s as transient', (_label, error) => {
    expect(isTransientError(error)).toBe(false);
  });
});
