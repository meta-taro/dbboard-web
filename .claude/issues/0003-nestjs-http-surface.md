# 0003 — NestJS HTTP surface (Phase 2 + Phase 3 controllers)

- **Status:** open
- **Phase:** 2 (mostly) + Phase 3 (the `POST /query` family)
- **Opened:** 2026-06-03
- **Closed:** —
- **Branch:** _to be created_ (`feature/phase-2-http-surface` suggested)
- **Depends on:** [0002](./0002-monorepo-scaffold.md) (monorepo scaffold), [0007](./0007-web-contract-mirror-v2.md) (contract mirror v2)
- **Unblocks:** [0004](./0004-postgres-adapter.md), [0005](./0005-row-cap-body-limit-conformance.md)

## Goal

Stand up the full NestJS HTTP surface that the contract describes — `GET /health`, `GET /tables`, `GET /capabilities`, `POST /query` — plus the web-specific connection-management surface from roadmap Phase 2 (`POST /connections`, `GET /connections`, `DELETE /connections/:id`, `POST /connections/:id/query`). All endpoints respond with the correct shapes behind a `NullAdapter` so 0004 can drop in a real Postgres adapter without touching the controller layer.

This is the controllers + DTOs + validation + error filter scaffold. No real database; no row cap; no conformance test. Each of those follow-on items has its own ticket so the diff stays reviewable per `AI_AGENT_RULES.md` §6.

## Scope

### Layered structure

Per `AI_AGENT_RULES.md` §3, business logic stays out of controllers. Layout under `apps/api/src/`:

```
apps/api/src/
├── domain/
│   ├── database-adapter.port.ts          # DatabaseAdapter interface
│   ├── values/                           # Value, Column, QueryResult, TableInfo, Capabilities
│   └── errors/                           # CategorizedError + 5 categories
├── usecase/
│   ├── get-health.use-case.ts
│   ├── list-tables.use-case.ts
│   ├── get-capabilities.use-case.ts
│   ├── execute-query.use-case.ts
│   ├── register-connection.use-case.ts
│   ├── list-connections.use-case.ts
│   ├── delete-connection.use-case.ts
│   └── connection-registry.port.ts
├── infrastructure/
│   ├── null-adapter.ts                   # DatabaseAdapter — empty/fixed values
│   └── in-memory-connection-registry.ts  # ConnectionRegistry — Map<id, adapter>
└── presentation/
    ├── health.controller.ts              # exists; refactor to use the use case
    ├── tables.controller.ts
    ├── capabilities.controller.ts
    ├── query.controller.ts
    ├── connections.controller.ts
    ├── dto/                              # class-validator DTOs
    └── filters/contract-error.filter.ts  # converts CategorizedError to `{ error: { category, message } }`
```

### Endpoints

**Contract-mirror surface** (must match `docs/api-contract.md` exactly):

| Method + path       | Returns                                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`       | `{ "status": "ok" }`                                                                                                                     |
| `GET /tables`       | `{ "tables": [ { "schema": null \| string, "name": string }, ... ] }`                                                                    |
| `GET /capabilities` | `{ "id": "null", "capabilities": { has_views: false, has_functions: false, has_auth: false, has_storage: false, has_realtime: false } }` |
| `POST /query`       | `{ "columns": [...], "rows": [[...], ...], "rows_affected": number }`                                                                    |

**Web-specific surface** (not in `docs/api-contract.md`):

| Method + path                 | Returns                                                                            |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `POST /connections`           | `{ "id": "<uuid>" }` — registers a connection definition, returns its id           |
| `GET /connections`            | `{ "connections": [ { "id", "label", "driver", ... } ] }` — never includes secrets |
| `DELETE /connections/:id`     | `204 No Content`                                                                   |
| `POST /connections/:id/query` | Same `QueryResult` shape as `POST /query` but scoped to the given connection       |

### Validation and request-level rejections

Per `docs/api-contract.md` § Request-level rejections, these come from the HTTP layer **before** any handler:

| Condition                                | HTTP status |
| ---------------------------------------- | ----------- |
| Body is not valid JSON                   | `400`       |
| Valid JSON missing the `sql` field       | `422`       |
| `Content-Type` is not `application/json` | `415`       |
| Body exceeds 64 KiB (`POST /query` only) | `413`       |

The 64 KiB cap lands fully in [0005](./0005-row-cap-body-limit-conformance.md); this ticket sets up the body-parser config seam so 0005 can drop the value in.

### Error envelope and `CategorizedError`

All non-2xx domain errors carry `{ "error": { "category": string, "message": string } }`. A single `ContractErrorFilter` (an `@Catch()` exception filter) takes any `CategorizedError` and writes the envelope with the right HTTP status:

| `category`        | HTTP | Throwable                           |
| ----------------- | ---- | ----------------------------------- |
| `query`           | 400  | `QueryError`                        |
| `type_conversion` | 422  | `TypeConversionError`               |
| `connection`      | 502  | `ConnectionError`                   |
| `schema`          | 502  | `SchemaError`                       |
| `capability`      | 404  | `CapabilityError` (ADR-0012 + 0007) |

Unknown `CategorizedError` subclasses are a bug — the filter throws at startup if it sees one without a category mapping.

### Open design question — how `POST /query` resolves a connection in a multi-connection world

The contract defines `POST /query` as single-connection (desktop runs against one DB at startup). Web is multi-connection. Three options:

- (a) `POST /query` uses an implicit "current" connection chosen via a header / cookie.
- (b) `POST /query` requires a default connection configured at startup (env var or first connection). 404 with category `capability` if no default exists. Multi-connection callers use `POST /connections/:id/query` explicitly. **(Recommended starting point.)**
- (c) `POST /query` does not exist on the web service. The conformance test in 0005 maps desktop's `POST /query` to web's `POST /connections/:id/query` at the test layer.

This ticket lands option (b). The conformance test in 0005 spins up a server with a default connection set, exercising the `POST /query` route as the contract describes. The multi-connection surface remains the primary production path. If real usage shows the default-connection shim is awkward, we revisit on a follow-up ticket.

## Tasks

- [ ] Add the domain ports (`DatabaseAdapter`, `ConnectionRegistry`) and value types (`Value`, `Column`, `QueryResult`, `TableInfo`, `Capabilities`) under `apps/api/src/domain/`. No NestJS imports in `domain/`.
- [ ] Add `CategorizedError` base + the 5 subclasses under `domain/errors/`.
- [ ] Implement `NullAdapter` (returns `[]` for `listTables`, the all-false `Capabilities` for `getCapabilities`, throws `CapabilityError` for `executeQuery`) and `InMemoryConnectionRegistry` under `infrastructure/`.
- [ ] Write the six use cases (`GetHealth`, `ListTables`, `GetCapabilities`, `ExecuteQuery`, `RegisterConnection`, `ListConnections`, `DeleteConnection`).
- [ ] Write the four controllers + DTOs. Use `class-validator` for the 422 vs 400 split (`@IsString() @IsNotEmpty() sql: string` produces 422 on missing/wrong type; malformed JSON falls through to Nest's default 400 handler).
- [ ] Wire the global `ContractErrorFilter` in `main.ts`.
- [ ] Configure `Content-Type` enforcement (415 when not `application/json`).
- [ ] Configure body-parser with a 64 KiB cap on `POST /query` (the actual limit lands in 0005; this ticket just exposes the seam).
- [ ] Refactor the existing `health.controller.ts` to call the `GetHealth` use case so the test continues to pass.
- [ ] Unit tests per layer: domain value invariants, each use case in isolation against a mock port, controllers via supertest.
- [ ] Integration test: spin up the Nest app, hit every endpoint, assert response shapes against fixtures derived from `docs/api-contract.md`.
- [ ] Update `.claude/project-status.md` to move `0003` from "Ready to start" → "In progress" / "Completed" and to flag `0004`/`0005` as the next steps.

## Definition of Done

Per `roadmap.md` Phase 2 + parts of Phase 3 (the query controller; row cap and conformance live in 0005):

- [ ] All seven endpoints respond with the contract-correct shape on a happy-path request.
- [ ] Request-level rejection matrix passes (invalid JSON → 400, missing `sql` → 422, wrong content-type → 415; body cap seam in place but value comes from 0005).
- [ ] All non-2xx domain errors carry `{ error: { category, message } }`. Categories cover `query` / `type_conversion` / `connection` / `schema` / `capability`.
- [ ] No business logic in controllers — controllers only translate HTTP to use case input / output.
- [ ] No secrets returned by `GET /connections` (password / connection-string fields stripped at the use case layer).
- [ ] Unit tests per layer + integration test for HTTP shape.
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.

## Verification

```sh
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build

# Smoke against the live server (port 4000 by default; adjust if changed).
pnpm --filter @dbboard-web/api start &
sleep 2
curl -s http://localhost:4000/health
curl -s http://localhost:4000/tables
curl -s http://localhost:4000/capabilities
curl -s -X POST http://localhost:4000/query \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT 1"}'
# Expect a capability 404 envelope from NullAdapter for /query.
```

## Notes

- Driver selection (`pg` vs `postgres.js`) is **not** decided here. That belongs in [0004](./0004-postgres-adapter.md).
- Connection persistence is **in-memory only** in this ticket. Whether to mirror desktop's TOML store (ADR-0013 on the desktop side) or use a different mechanism is a separate decision; for now state lives in the registry singleton and is lost on restart.
- The contract's "blob = `{ "$blob": "<base64>" }`" shape is implemented in `domain/values/value.ts` so 0004's Postgres `bytea` decoder has a place to write to.
