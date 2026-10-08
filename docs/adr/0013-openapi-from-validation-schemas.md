# ADR 0013 — OpenAPI document generated from the validation schemas

- **Status:** Accepted
- **Date:** 2026-10-09

## Context

Clients need a machine-readable description of the API, and SPEC §5.5 promised `GET /docs`. Documentation written
separately from the code drifts: a field is added to a handler and not to the document, or a status code changes. The
request schemas already exist as Zod schemas, which the handlers validate with.

## Decision

- Every HTTP operation is listed once in `apiOperations` (`src/modules/docs/api-operations.ts`): method, path, the
  Zod schemas its handler validates with (body, query, path parameters) and, per status code, a strict Zod schema of
  the response body and its headers.
- The OpenAPI 3.1 document is generated from that table with Zod's `z.toJSONSchema` (JSON Schema 2020-12, the
  dialect of OpenAPI 3.1). Request bodies are converted as their input (a timestamp is a string before it becomes a
  Date). Refinements that JSON Schema cannot express (a closed ring, `from` before `to`) are described in prose.
- **A contract test keeps the document honest** (`test/openapi.e2e-spec.ts`). It starts the application and checks
  that every registered route is documented and every documented operation exists, and that real responses (successes
  and errors) have a documented status, content type and required headers and match their strict schema. A field
  added to a response without documenting it fails the test.
- `GET /docs` serves Swagger UI from the `swagger-ui-dist` package (no CDN), `GET /docs/openapi.json` the document.
  Both are public and enabled by default except when `NODE_ENV=production` (`OPENAPI_ENABLED` overrides it); the
  compose stack enables them for local use. The document passes Redocly's linter.

## Alternatives considered

- **`@nestjs/swagger` decorators** on controllers and DTO classes: a second description of every field next to the
  Zod schema, which is exactly the duplication that drifts.
- **A hand-written `openapi.yaml`:** the same duplication, without any check.
- **Generating the document at build time into the repository:** reviewable diffs, but one more artifact to keep in
  sync; the contract test already detects changes.

## Consequences

- A new route needs an entry in `apiOperations`, or the contract test fails.
- Response schemas are written once more in Zod (the resources are TypeScript types); the contract test is what keeps
  the two in line.
- `swagger-ui-dist` adds ~12 MB to the image (the page itself loads two files of ~1.8 MB).
