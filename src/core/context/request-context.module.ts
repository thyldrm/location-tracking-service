import type { IncomingMessage, ServerResponse } from 'node:http';
import { Global, Module } from '@nestjs/common';
import { type ClsModuleFactoryOptions, ClsModule, type ClsService } from 'nestjs-cls';
import { IdGenerator } from '../foundation/id-generator.js';
import { CORRELATION_ID_HEADER, ensureCorrelationId } from './correlation-id.js';
import { RequestContext } from './request-context.js';

/**
 * Opens an AsyncLocalStorage context for every HTTP request as the very first step of the request
 * pipeline, resolves its correlation id and echoes it in the `x-request-id` response header.
 */
@Global()
@Module({
  imports: [
    ClsModule.forRootAsync({
      global: true,
      inject: [IdGenerator],
      useFactory: (ids: IdGenerator): ClsModuleFactoryOptions => ({
        middleware: {
          mount: true,
          generateId: true,
          // No proxy providers are used; resolving them costs a dynamic import() on every request.
          resolveProxyProviders: false,
          idGenerator: (request: IncomingMessage) => ensureCorrelationId(request, () => ids.next()),
          setup: (cls: ClsService, _request: IncomingMessage, response: ServerResponse) => {
            response.setHeader(CORRELATION_ID_HEADER, cls.getId());
          },
        },
      }),
    }),
  ],
  providers: [RequestContext],
  exports: [RequestContext],
})
export class RequestContextModule {}
