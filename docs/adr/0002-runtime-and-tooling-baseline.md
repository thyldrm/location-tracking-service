# ADR 0002 — Runtime and tooling baseline

- **Status:** Accepted
- **Date:** 2026-10-07

## Decision

| Concern       | Choice                                                                               | Reason                                                                                                                                     |
| ------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Runtime       | Node.js 24 LTS                                                                       | Current LTS line; native `process.loadEnvFile`, `require(esm)`, `fetch`.                                                                   |
| Framework     | NestJS 12 (required by the case)                                                     | Module system and dependency injection keep infrastructure replaceable and testable.                                                       |
| Module format | ESM (`"type": "module"`)                                                             | NestJS 12 ships ESM; it is the default for new projects.                                                                                   |
| HTTP adapter  | Fastify instead of Express                                                           | Higher throughput and lower per-request overhead on the ingestion path; built-in schema-aware body limits and native `inject()` for tests. |
| Language      | TypeScript 6, `strict`                                                               | Version supported by the NestJS 12 toolchain.                                                                                              |
| Configuration | Zod schema, validated before the Nest container starts                               | Fail fast with a readable error; typed access through `ConfigService<Env, true>`.                                                          |
| Tests         | Vitest                                                                               | NestJS 12 default for ESM projects; fast, native ESM.                                                                                      |
| Lint / format | oxlint (type-aware) + Prettier                                                       | NestJS 12 default; type-aware rules such as `no-floating-promises` catch unawaited async work.                                             |
| Commits       | Conventional Commits, enforced by commitlint + husky                                 | Readable history; enables automated changelogs.                                                                                            |
| Container     | Multi-stage build, `node:24-bookworm-slim`, non-root user, `npm ci --ignore-scripts` | Small runtime image without build tooling; glibc base keeps native modules (librdkafka) straightforward.                                   |

## Consequences

- Relative imports must carry the `.js` extension (ESM resolution).
- Logs go to stdout as JSON (12-factor); the platform collects them. The service never writes log files.
