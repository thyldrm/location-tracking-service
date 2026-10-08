import type { IncomingMessage } from 'node:http';
import { CORRELATION_ID_HEADER, ensureCorrelationId } from './correlation-id.js';

function requestWith(headers: IncomingMessage['headers']): IncomingMessage {
  return { headers } as IncomingMessage;
}

const generate = () => 'generated-id';

describe('ensureCorrelationId', () => {
  it('keeps a valid incoming id', () => {
    const request = requestWith({ [CORRELATION_ID_HEADER]: 'gateway-1234.abc:9' });

    expect(ensureCorrelationId(request, generate)).toBe('gateway-1234.abc:9');
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['containing a line break (log injection)', 'abc\ninjected'],
    ['containing spaces', 'abc def'],
    ['longer than 128 characters', 'a'.repeat(129)],
    ['sent more than once', ['one', 'two']],
  ])('generates a new id when the incoming one is %s', (_case, value) => {
    const request = requestWith({ [CORRELATION_ID_HEADER]: value });

    expect(ensureCorrelationId(request, generate)).toBe('generated-id');
  });

  it('writes a generated id back to the request so later readers see the same value', () => {
    const request = requestWith({});

    ensureCorrelationId(request, generate);

    expect(request.headers[CORRELATION_ID_HEADER]).toBe('generated-id');
    expect(ensureCorrelationId(request, () => 'another-id')).toBe('generated-id');
  });
});
