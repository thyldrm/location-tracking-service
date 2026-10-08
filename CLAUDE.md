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
npm run migration:run    # apply pending migrations (after `npm run build`)
npm run migration:revert # revert the most recent migration
docker compose up -d     # PostgreSQL/PostGIS, Kafka, Redis
docker compose --profile app up -d --build   # infrastructure + api + worker containers
```

## Architecture map

- `src/main.ts` — API role entrypoint. `src/worker.ts` — worker role entrypoint. `src/migrate.ts` — migration
  runner. Same image, different command.
- `src/api.module.ts`, `src/worker.module.ts` — root modules per role; both import `CoreModule`.
- `src/core/` — cross-cutting infrastructure shared by both roles (config, logging, database, messaging, cache).
- `src/modules/<feature>/` — feature modules (areas, locations, area-entries, presence, outbox, health).
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
- **Errors:** throw domain or HTTP exceptions; the global exception filter turns them into RFC 9457 problem details.
  Never leak internal error messages or stack traces to clients.
- **Logging:** use the injected logger; structured fields, not string concatenation. Never log secrets or full payloads
  of personal data at `info` level.
- **Database:** schema changes only through migrations; `synchronize` stays `false`. When a migration changes the
  schema, update the entities too: the schema-drift integration test fails otherwise. Multi-row writes that must be
  consistent go into one explicit transaction. Use keyset pagination, not `OFFSET`.
- **Messaging:** delivery is at-least-once; every consumer must be idempotent. Never publish to Kafka inside a
  database transaction — write to the outbox instead.
- **Tests:** unit tests live next to the code as `*.spec.ts`; e2e/integration tests live in `test/`.
  Behaviour described in `SPEC.md` should have a test.

## Git

- Conventional Commits (`feat:`, `fix:`, `chore:`, `docs:`, `test:`, `refactor:`, `build:`, `ci:`), enforced by commitlint.
- Small, focused commits; each commit builds and passes lint and tests.
