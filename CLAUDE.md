# CLAUDE.md

Guidance for AI coding assistants (Claude Code) working in this repository.

## Project

Location Tracking Service: NestJS microservice that ingests user location pings, detects entries into
polygonal areas and records them. **`SPEC.md` is the source of truth** for behaviour, API contracts,
data model and failure handling. Read it before changing behaviour, and update it in the same change
when behaviour changes.

## Commands

```bash
npm run build            # compile to dist/
npm run start:dev        # API role with watch mode
npm run start:worker:dev # worker role with watch mode
npm run lint             # oxlint (type-aware)
npm run format           # prettier --write
npm run typecheck        # tsc --noEmit
npm test                 # unit tests (vitest), no infrastructure needed
npm run test:integration # integration + e2e tests against real containers (Testcontainers; Docker required)
npm run migration:run    # build, then apply pending migrations
npm run migration:revert # build, then revert the most recent migration
npm run topics:provision # build, then create missing Kafka topics
docker compose up -d     # PostgreSQL/PostGIS, Kafka, Redis
docker compose --profile app up -d --build   # infrastructure + migrations + topics + api + worker containers
docker compose run --rm k6 run /load/ingest.js   # load test of ingestion against the running stack (load/README.md)
```

## Architecture map

- `src/main.ts` — API role entrypoint. `src/worker.ts` — worker role entrypoint. `src/migrate.ts` — migration
  runner. Same image, different command.
- `src/api.module.ts`, `src/worker.module.ts` — root modules per role; both import `CoreModule`.
- `src/core/` — cross-cutting infrastructure shared by both roles (config, logging, database, messaging, cache).
- `src/modules/<feature>/` — feature modules (areas, locations, area-index, entry-detection, area-entries, presence,
  outbox, idempotency, housekeeping, health).
- `src/core/database/migrations/` — hand-written SQL migrations (the only way the schema changes), registered in
  `migrations/index.ts`. Entities map the schema and are listed in `src/core/database/entities.ts`.
- `docs/adr/` — Architecture Decision Records. Add one for every significant technical choice.

## Conventions

- **ESM:** the project is `"type": "module"`. Relative imports must use the `.js` extension
  (`import { Foo } from './foo.js'`). Use `import.meta.dirname` instead of `__dirname`.
- **TypeScript:** `strict` mode. No `any` in application code; prefer `unknown` + narrowing.
- **Dependency injection:** never instantiate services, clients, clocks or id generators with `new` inside
  business code. Inject them so they can be replaced in tests (`Clock`, `IdGenerator` abstractions).
- **Configuration:** the environment is validated once at startup (`loadEnv`). Providers read it through the typed
  `ConfigService<Env, true>`; infrastructure modules may receive the validated `Env` in `forRoot(env)`. Never read
  `process.env` outside `src/core/config`. Every new variable goes into the Zod schema and `.env.example`.
- **Errors:** throw `AppError` subclasses from `src/core/errors/app-errors.ts` (`NotFoundError`, `ConflictError`, ...).
  `ProblemDetailsFilter` renders every error as RFC 9457 problem details; never build error responses by hand and
  never leak internal error messages or stack traces to clients. New mappings go into `resolveProblem` with a test.
- **API documentation:** every HTTP operation is listed in `apiOperations` (`src/modules/docs/api-operations.ts`),
  with the schemas its handler validates with and a strict schema per response. The OpenAPI document is generated
  from it; `test/openapi.e2e-spec.ts` fails when a route or a response is not documented.
- **Validation:** validate every request input with a Zod schema through `ZodValidationPipe`
  (`@Body(new ZodValidationPipe(schema))`); handlers receive the parsed output only. A pipe that needs configuration is
  an `@Injectable()` subclass passed by class (`@Body(CreateAreaValidationPipe)`).
- **Request context:** read the correlation id through `RequestContext`; wrap non-HTTP units of work (e.g. a consumed
  message) in `RequestContext.run(correlationId, ...)`. Do not use request-scoped providers.
- **Authentication:** every API route requires `x-api-key` by default; mark intentionally open routes with `@Public()`.
- **Logging:** inject `PinoLogger` (`@InjectPinoLogger(Context.name)`); pass structured fields as the first argument,
  not string concatenation (`logger.info({ areaId }, 'Area created')`). No `console.*`. Never log secrets or full payloads
  of personal data at `info` level.
- **Database:** schema changes only through migrations; `synchronize` stays `false`. When a migration changes the
  schema, update the entities too: the schema-drift integration test fails otherwise. Multi-row writes that must be
  consistent go into one explicit transaction. Use keyset pagination, not `OFFSET`.
- **Queries:** use TypeORM (Repository / QueryBuilder) wherever it can express the query — it covers
  `ON CONFLICT` (`orIgnore` / `orUpdate`), `RETURNING` and `FOR UPDATE SKIP LOCKED` (`setOnLocked`). Raw SQL only
  with a concrete reason: migrations, PostgreSQL features TypeORM has no API for (e.g. advisory locks), and tests that
  verify database rules independently of the ORM. Raw SQL is always parameterized and lives in the infrastructure /
  repository layer, never in controllers or services.
- **Messaging:** delivery is at-least-once; every consumer must be idempotent. Never publish to Kafka inside a
  database transaction — write to the outbox instead (`OutboxWriter.append(manager, event)` with the transaction's
  `EntityManager`). Topic names live in `src/core/messaging/topics.ts`, their settings in `topic-definitions.ts`
  (topics are never auto-created). Publish through the `MessageProducer` abstraction, never the Kafka client directly.
- **Work that must run on one instance** (outbox relay, housekeeping): take `tryAdvisoryXactLock` at the start of each
  short transaction instead of holding a session-level lock: the lock then ends with the transaction, also when the
  holder dies. Keys live in `AdvisoryLock` (`src/core/database/advisory-locks.ts`).
- **Background loops** (consumers, relay, housekeeping): start in `onApplicationBootstrap` without awaiting, stop through
  an `AbortController` in `onApplicationShutdown`, back off with `backoffDelayMs` + `withJitter` on failure, and never
  let one failure end the loop.
- **Metrics:** define every metric in `Metrics` (`src/core/metrics/metrics.ts`) and inject it; never use
  prom-client's global registry. Label values come from small fixed sets (route templates, outcomes), never ids or
  user input. Count what actually happened (e.g. entries written), not what was attempted.
- **Readiness:** only process state (startup gates via `ProcessLifecycle.addReadinessGate`, draining) decides
  `/health/ready`; shared dependencies are reported, not checked for readiness (ADR 0010).
- **Hot path:** code that runs on every request (middleware, guards, pipes, hooks) bounds the capacity of an API
  instance (ADR 0011). Keep it free of per-request dynamic imports and avoidable round trips; measure changes to it
  with the load test.
- **Optional dependencies:** Redis is never required for correctness: code that uses it must degrade (fail open)
  when it is unavailable. Kafka is required for ingestion only; the process must start and serve other endpoints
  without it.
- **Logging volume:** high-volume endpoints log access at `debug`. Errors raised on purpose for an outage (`429`,
  `503`) are `expected`; report the outage once where it is detected, not per request.
- **Transient failures:** classify with `isTransientError` (`src/core/errors/transient-errors.ts`): the API answers them
  with `503`, the worker retries them with back-off. Anything else in the worker is retried a few times, then sent to the
  dead letter topic with the error in its headers.
- **TypeORM `returning`:** pass a string (`.returning('entry_id, entered_at')`), which is used verbatim. An array is read
  as entity property names and silently dropped when it contains column names.
- **Uniqueness:** enforce it with a named unique constraint and translate the violation (`isUniqueViolation`) into a
  `ConflictError`; never "check, then insert".
- **Tests:** unit tests live next to the code as `*.spec.ts`; e2e/integration tests live in `test/`.
  Behaviour described in `SPEC.md` should have a test.

## Git

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`), enforced by commitlint.
- Small, focused commits; each commit builds and passes lint and tests.

## Local development

- Documented commands must work unchanged in bash, zsh and PowerShell: no `VAR=value cmd` prefixes and no `&&`
  chains in docs (Windows PowerShell 5.1 has no `&&`). Put chains inside npm scripts instead.
- `HTTP_PORT` is optional; the api defaults to 3000 and the worker to 3001 so both run side by side.
