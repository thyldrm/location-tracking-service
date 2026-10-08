import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Controller, Get, Header, Injectable, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../../core/config/env.schema.js';
import { Public } from '../../core/security/public.decorator.js';
import { apiOperations } from './api-operations.js';
import { buildOpenApiDocument } from './openapi-document.js';

const require = createRequire(import.meta.url);

/** Static Swagger UI assets, served by the service so the page needs no access to a CDN. */
const ASSETS = ['swagger-ui.css', 'swagger-ui-bundle.js'] as const;

const PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Location Tracking Service API</title>
    <link rel="stylesheet" href="/docs/swagger-ui.css" />
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="/docs/swagger-ui-bundle.js"></script>
    <script>
      SwaggerUIBundle({ url: '/docs/openapi.json', dom_id: '#swagger-ui', persistAuthorization: true });
    </script>
  </body>
</html>
`;

/** The OpenAPI document and the Swagger UI files, prepared once at startup. */
@Injectable()
export class ApiDocs implements OnModuleInit {
  readonly document: Record<string, unknown>;
  readonly assets = new Map<(typeof ASSETS)[number], Buffer>();

  constructor(config: ConfigService<Env, true>) {
    this.document = buildOpenApiDocument(
      apiOperations({ maxVertices: config.get('AREA_MAX_VERTICES', { infer: true }) }),
    );
  }

  async onModuleInit(): Promise<void> {
    for (const asset of ASSETS) {
      this.assets.set(asset, await readFile(require.resolve(`swagger-ui-dist/${asset}`)));
    }
  }

  asset(name: (typeof ASSETS)[number]): Buffer {
    const content = this.assets.get(name);
    if (!content) throw new Error(`Swagger UI asset ${name} is not loaded`);
    return content;
  }
}

/**
 * API documentation: `GET /docs` (Swagger UI) and `GET /docs/openapi.json`. Only registered when
 * `OPENAPI_ENABLED` is true (by default everywhere except in production).
 */
@Public()
@Controller('docs')
export class DocsController {
  constructor(private readonly docs: ApiDocs) {}

  @Get()
  @Header('content-type', 'text/html; charset=utf-8')
  page(): string {
    return PAGE;
  }

  @Get('openapi.json')
  document(): Record<string, unknown> {
    return this.docs.document;
  }

  @Get('swagger-ui.css')
  @Header('content-type', 'text/css; charset=utf-8')
  @Header('cache-control', 'public, max-age=86400')
  stylesheet(): Buffer {
    return this.docs.asset('swagger-ui.css');
  }

  @Get('swagger-ui-bundle.js')
  @Header('content-type', 'text/javascript; charset=utf-8')
  @Header('cache-control', 'public, max-age=86400')
  script(): Buffer {
    return this.docs.asset('swagger-ui-bundle.js');
  }
}
