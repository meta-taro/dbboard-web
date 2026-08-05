# 0004 — Postgres adapter (Phase 2 / Phase 3)

- **Status:** open
- **Phase:** 2 / 3 (the first real `DatabaseAdapter` implementation)
- **Opened:** 2026-06-03
- **Closed:** —
- **Branch:** _to be created_ (`feature/phase-2-postgres-adapter` suggested)
- **Depends on:** [0003](./0003-nestjs-http-surface.md) (HTTP surface + `DatabaseAdapter` port)
- **Unblocks:** [0005](./0005-row-cap-body-limit-conformance.md) (conformance test needs a real adapter to exercise)

## Goal

Implement the `DatabaseAdapter` port from 0003 against a real PostgreSQL backend so `POST /connections` registers a working adapter and `POST /connections/:id/query` returns real rows. The adapter must decode every Postgres value into the contract's `Value` union (Null / Integer / Real / Text / Blob) without silent truncation.

This is also the first integration-test-against-a-real-DB ticket. The test stack picks up `testcontainers` so contributors can run the full suite locally as long as Docker is available.

## Scope

### Driver selection

| Driver        | Why pick it                                                                                      | Why not                                                              |
| ------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `pg`          | De-facto standard; battle-tested; rich type-parser ecosystem (`pg-types`); types in `@types/pg`. | API is older; callback-shaped under the surface.                     |
| `postgres.js` | Modern, tagged-template API; native ESM; smaller dep tree.                                       | Smaller ecosystem; harder to debug edge cases against Neon/Supabase. |

**Recommendation:** `pg` for the first cut — boring, predictable, easy to find help when an edge case bites. Revisit if it becomes a bottleneck.

### Connection configuration

- Connection definition (registered via `POST /connections`) carries: `driver: "postgres"`, `label`, and either a `connectionString` or split host/port/db/user/password.
- `sslmode=prefer` is the default; `require` is auto-upgraded for Neon (`*.neon.tech`) and Supabase (`*.supabase.co`).
- Statement timeout configured per query (default 30 s; configurable per connection).
- The password / connection string is **never** logged. `GET /connections` strips it. `console.log(error)` on a connect failure must not leak the URL.

### Adapter methods

| Method              | SQL                                                                                                                                                                                   |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `health()`          | `SELECT 1` — bounded by a 1 s timeout. Returns `{ status: "ok" }` or throws `ConnectionError`.                                                                                        |
| `listTables()`      | `SELECT schemaname AS schema, tablename AS name FROM pg_catalog.pg_tables WHERE schemaname NOT IN ('pg_catalog', 'information_schema') ORDER BY schemaname, tablename`                |
| `getCapabilities()` | Returns `{ id: "postgres", capabilities: { has_views: false, has_functions: false, has_auth: false, has_storage: false, has_realtime: false } }` (per 0007 — all `false` in Phase 2). |
| `executeQuery(sql)` | `client.query({ text: sql, rowMode: 'array' })` so rows arrive as positional arrays. Map columns + decode values per the table below.                                                 |

### Type mapping (`pg_type.oid` → `Value`)

| Postgres type                                   | OID(s)                     | `Value`                                                                                                                         |
| ----------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `NULL`                                          | —                          | `Null`                                                                                                                          |
| `int2` / `int4`                                 | 21 / 23                    | `Integer(number)`                                                                                                               |
| `int8`                                          | 20                         | `Integer(number)` if within `Number.MAX_SAFE_INTEGER`; else `Text(string)` with a `type_conversion` error logged but not thrown |
| `float4` / `float8`                             | 700 / 701                  | `Real(number)`                                                                                                                  |
| `numeric` / `decimal`                           | 1700                       | `Real(number)` if parseable as finite; else `Text(string)`                                                                      |
| `bool`                                          | 16                         | `Integer(0)` or `Integer(1)` to match the contract's lack of a bool variant                                                     |
| `bytea`                                         | 17                         | `Blob(base64-standard)` → `{ "$blob": "<base64>" }`                                                                             |
| `text` / `varchar` / `char` / `bpchar` / `name` | 25 / 1043 / 18 / 1042 / 19 | `Text(string)`                                                                                                                  |
| `uuid`                                          | 2950                       | `Text(string)`                                                                                                                  |
| `json` / `jsonb`                                | 114 / 3802                 | `Text(string)` (raw JSON text; the UI can re-parse)                                                                             |
| `timestamp` / `timestamptz` / `date` / `time`   | 1114 / 1184 / 1082 / 1083  | `Text(string)` ISO 8601 (`YYYY-MM-DDTHH:MM:SS[.fff][Z]`)                                                                        |
| anything else                                   | —                          | `Text(string)` — falling back to the driver's text representation, plus an INFO log so we notice                                |

`int8` outside the safe range and `numeric` that can't round-trip are the two known lossy paths. Both surface as `Text` so the UI shows the real value; the desktop side has the same compromise.

### Connection registry wiring

- `POST /connections` (already shipped in 0003 with NullAdapter) now constructs a `PostgresAdapter` when `driver: "postgres"` and stores it in the registry.
- `DELETE /connections/:id` closes the pool before evicting.
- A single `pg.Pool` per connection (not per request). Default pool size: 4. Idle timeout: 30 s.

### Tests

- **Unit:** type-mapping table tested in isolation with a fake `pg` response (one test per row in the table above).
- **Integration:** `testcontainers-node` spins up Postgres 16, runs a fixture `init.sql` (one row of every mapped type), then asserts each `executeQuery` decoding round-trips correctly through the HTTP layer.
- **Skip gate:** integration tests gate on `DOCKER_HOST` / `process.env.CI` being set, or detect Docker availability and skip with a clear message otherwise (matches desktop's policy of "real DB tests skip locally if the runtime isn't available").

## Tasks

- [ ] Add `pg` + `@types/pg` to `apps/api/package.json`. Respect `minimumReleaseAge`. `pg` does not need install scripts; do **not** widen `pnpm-workspace.yaml` allowBuilds.
- [ ] Add `testcontainers` as a dev dependency for `apps/api`.
- [ ] Implement `PostgresAdapter` under `apps/api/src/infrastructure/postgres-adapter.ts`.
- [ ] Implement the `pgOidToValue` decoder under `infrastructure/postgres-type-mapping.ts`.
- [ ] Wire the adapter factory: `RegisterConnection.execute({ driver: "postgres", ... })` → `new PostgresAdapter(...)` → registry.
- [ ] Strip secrets at the use case boundary so `GET /connections` cannot leak passwords; add a unit test that asserts the leak path is closed.
- [ ] Auto-upgrade `sslmode` for Neon / Supabase hostnames.
- [ ] Unit tests for the OID decoder (one per row in the type-mapping table).
- [ ] Integration test against testcontainers Postgres 16: `init.sql` fixture covers each mapped type; assertions hit the HTTP layer (via supertest) to exercise the full stack.
- [ ] Document the local-DB setup in `apps/api/README.md` (or top-level README, whichever fits): `docker run -p 5432:5432 postgres:16-alpine`, env var to point at it, `pnpm --filter @dbboard-web/api test` runs the integration tests with `DOCKER_HOST` set.
- [ ] `.env.example` entry for the dev Postgres URL.
- [ ] Update `.claude/project-status.md` when this lands.

## Definition of Done

Per `roadmap.md` Phase 2:

- [ ] `POST /connections` with `{ "driver": "postgres", ... }` registers a real Postgres adapter; `GET /connections/:id/query` returns rows from the live DB.
- [ ] `GET /capabilities` against a Postgres-registered connection returns `{ "id": "postgres", "capabilities": { ... all false } }`.
- [ ] Every type-mapping table row has a passing unit test.
- [ ] Integration test against testcontainers Postgres passes when Docker is available; skips with a clear message when not.
- [ ] No password / connection-string text appears in logs or `GET /connections` responses.
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.

## Verification

```sh
# Unit + integration (integration requires Docker).
pnpm -r test

# Manual smoke against a local Postgres.
docker run --rm -d -e POSTGRES_PASSWORD=dev -p 5432:5432 --name dev-pg postgres:16-alpine
sleep 3
pnpm --filter @dbboard-web/api start &
sleep 2

# Register a connection.
# Since 0027 slice A this needs `?sslmode=disable` appended: TLS is now
# required unless refused explicitly, and the container above has none.
# Left as written to record what the command was when 0004 closed.
CONN_ID=$(curl -s -X POST http://localhost:4000/connections \
  -H 'Content-Type: application/json' \
  -d '{"driver":"postgres","label":"dev","connectionString":"postgres://postgres:dev@localhost:5432/postgres"}' \
  | jq -r .id)

# Capabilities should show the postgres id.
curl -s http://localhost:4000/capabilities

# Run a query.
curl -s -X POST "http://localhost:4000/connections/$CONN_ID/query" \
  -H 'Content-Type: application/json' \
  -d '{"sql":"SELECT 1 AS one, true AS yes, NULL AS empty"}'

# Cleanup.
docker rm -f dev-pg
```

## Notes

- Multi-driver support (libSQL / Turso, Supabase native client) is out of scope here. They are explicitly listed in `README.md` § Stack but ship in later tickets so the Postgres adapter can stabilize first.
- The `int8` and `numeric` lossy paths are documented in the contract footnote on the desktop side; mirror that note into the web docs if it shifts.
- Streaming / pagination as an escape hatch from the 10k-row cap (delivered in 0005) is **out of scope** here too. It needs an ADR pair across both repos.
