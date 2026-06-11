# 0009 — Web query-history schema mirror (ADR-0017)

- **Status:** open
- **Phase:** web-side Phase 2 (desktop equivalent: ADR-0017, Stage 2)
- **Opened:** 2026-06-04
- **Closed:** —
- **Suggested branch:** `feature/history-schema-mirror-impl` (this file lands on `feature/history-schema-mirror`)
- **Depends on:** [`0003`](./0003-nestjs-http-surface.md) (need a NestJS request lifecycle to hook into) and [`0004`](./0004-postgres-adapter.md) (need a real adapter so `conn`, `rows`, `rows_affected`, `duration_ms` are populated from real responses, not the `NullAdapter`).
- **Anchors:** desktop ADR-0017 at `dbboard@62ed834:docs/decisions.md`; reference implementation at `dbboard@72cb165:crates/dbboard-ui/src/history.rs`; cross-repo brief at `dbboard@c7aac22:.claude/issues/0003-web-history-schema-mirror.md`; mirrored verbatim at [`../handoff/2026-06-04-history-schema-mirror-incoming.md`](../handoff/2026-06-04-history-schema-mirror-incoming.md).

## Goal

Adopt the **per-record JSON schema** defined by desktop ADR-0017 for query-history persistence on the web side. Same field names, same types, same `v`, same `status` values, same error envelope nesting. Storage location, write path, rotation, retention, and read API are web's call.

This issue covers **schema-shaped implementation work** on web. The handoff brief is filed at the path above and is the receipt; this issue is the actionable scope.

## What this is — and what it isn't

**Is:**

- A record-shape contract between desktop's `history.jsonl` and the web service's history store.
- A web ADR (TBD number) recorded in `.claude/decisions.md` (or a new top-level `docs/decisions.md` if/when we adopt that pattern) that **cites** desktop ADR-0017 by anchor rather than re-stating the schema.
- A NestJS persistence module that emits one ADR-0017-shaped record per query completion (success or error) and an export endpoint that streams `application/x-ndjson`.

**Isn't:**

- A wire-contract change. No `GET /history` lands in `docs/api-contract.md`. ADR-0017 §8 is explicit about keeping history off the cross-repo HTTP surface.
- A copy of the schema text into `docs/api-contract.md`. The schema lives in desktop ADR-0017 as the single source of truth; the web ADR references it.
- A redactor for SQL strings. ADR-0017 §7 logs queries verbatim and the web brief confirms web does the same — secret access control lives in the storage / read-API layer, not in the schema.

## Snapshot pointer

- **Mirroring from:** `dbboard@c7aac22:.claude/issues/0003-web-history-schema-mirror.md` (the cross-repo brief); ADR text at `dbboard@62ed834:docs/decisions.md` (search `## ADR-0017`); reference implementation at `dbboard@72cb165`; closeout at `dbboard@ae86627`.
- **Maintainer policy quote (2026-06-03):** 「共有というのはログの吐き先とかではなく、同一ログ形式である。同じブランド、サービスなので。」 → same brand, same service → same log record format.

## Scope (what to mirror)

### Record schema (copy verbatim from ADR-0017 §2)

```jsonc
{
  "v": 1, // schema version
  "ts": "2026-06-04T14:22:01.123Z", // RFC 3339, UTC, ms precision
  "conn": "prod-pg", // connection id
  "actor": "alice@example.com", // web populates; desktop emits null
  "sql": "SELECT * FROM users LIMIT 10",
  "status": "ok", // "ok" | "error"
  "duration_ms": 42, // wall-clock submit -> envelope
  "rows": 10, // row-returning result; null otherwise
  "rows_affected": null, // DML result; null otherwise
  "error": null, // {category, message} when status="error"
}
```

### Web-specific field semantics

| Field                     | Web semantics                                                                                                                                                                                                                |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `v`                       | Literal `1`. Bump requires cross-repo ADR.                                                                                                                                                                                   |
| `ts`                      | RFC 3339, UTC (`Z` suffix), millisecond precision. Use `new Date().toISOString()` directly — Node's output matches this shape.                                                                                               |
| `conn`                    | The server-side connection record id (per `POST /connections`), **not** a per-user alias.                                                                                                                                    |
| `actor`                   | Authenticated session subject (user id / email / opaque sub). `null` only for unauthenticated requests. **Never** the empty string. Until auth lands, all records carry `null` and a follow-up ticket flips it.              |
| `sql`                     | Literal text. Do not redact, do not normalise.                                                                                                                                                                               |
| `status`                  | `"ok"` or `"error"`. Future `"cancelled"` / `"timeout"` are additive.                                                                                                                                                        |
| `duration_ms`             | Wall-clock from request receipt to response envelope formation. Integer.                                                                                                                                                     |
| `rows` vs `rows_affected` | Mutually exclusive per ADR-0017 §2. SELECT → `rows: <int>, rows_affected: null`. DML → inverse. DDL/no-result `ok` → both `null`.                                                                                            |
| `error`                   | `{ category, message }` where `category ∈ { connection \| query \| schema \| type_conversion \| capability }` — same taxonomy that backs `CategorizedError` in `apps/api`. Message is raw English (no i18n applied to logs). |

### Forward-compat policy

- **Writer:** emit only the fields above.
- **Reader:** accept unknown fields silently; drop records with unknown `v` or unknown `status` and increment an observable counter (log line, metric, or both).

### Storage (web's call)

ADR-0017 explicitly defers storage to web. Recommended target (non-binding):

- **Per-tenant Postgres table** with a `jsonb payload` column whose value is exactly the record above, plus a `payload->>'v' = '1'` partial index. Reuse `payload->>'ts'` for sort/filter rather than introducing a separate `created_at` column.
- **Export endpoint** at `GET /history/export.jsonl` (or `Accept: application/x-ndjson` on a base path) that streams records in line-delimited JSON so `cat dbboard-history.jsonl | curl --data-binary @-` round-trips.

### Rotation / retention (web's call)

A product decision, not a schema decision. Sized to whatever audit-log retention the deployment runs.

### Secret handling (web's deployment ADR)

Schema and contents stay verbatim per ADR-0017 §7. Tenant scoping, retention, and admin-side affordances are a **web-side ADR** (separate from this issue). Suggested defaults:

- Tenant-scoped read API. No cross-tenant access.
- Retention aligned with audit log retention.
- No admin-side "all queries" view unless the deployment's privacy stance permits it.

## Out of scope (intentionally)

- `GET /history` in `docs/api-contract.md` — ADR-0017 §8.
- A `v: 2` schema — wait for desktop.
- Encryption at rest — orthogonal to schema mirror.
- Admin tenant analytics — needs separate access-control ADR.
- Schema implementation against the `NullAdapter` only — depends on [`0004`](./0004-postgres-adapter.md) for meaningful `conn` / `rows` / `rows_affected`.

## Tasks

- [x] Receive desktop's brief into [`../handoff/2026-06-04-history-schema-mirror-incoming.md`](../handoff/2026-06-04-history-schema-mirror-incoming.md).
- [x] Open this issue (`0009`) and update [`project-status.md`](../project-status.md) with the incoming brief and refreshed desktop snapshot pointer.
- [x] Draft web ADR — `.claude/decisions.md` "2026-06-05 — Query-history persistence mirrors desktop ADR-0017 (web Stage 2)" cites desktop ADR-0017 by anchor (`dbboard@62ed834:docs/decisions.md`) without restating the schema; records only the web-specific I/O bits (in-memory default adapter, retention deferred to the Postgres follow-up, `actor=null` until auth, NestJS interceptor write path, `_default` sentinel for connection-less `/query`).
- [x] Define the record shape as a Zod schema at `apps/api/src/domain/history-record.ts` (commit `a8b76e3`). Verbatim ADR-0017 §2 mirror, `superRefine` enforces the three cross-field invariants.
- [x] Implement a `RecordHistory` usecase that consumes the existing `QueryResult` + request metadata and persists one record per query completion (commit `57e6e78`). Wired into `POST /query` and `POST /connections/:id/query` behind `HistoryRecordingInterceptor` via `@UseInterceptors(HistoryRecordingInterceptor)` on `QueryController` (commit `8c87f13`).
- [x] Implement a storage adapter behind a `HISTORY_STORE` symbol provider token, parallel to `DATABASE_ADAPTER` / `CONNECTION_REGISTRY` (commit `0f649ce`). Default is `InMemoryHistoryStore`; a Postgres-backed adapter is a follow-up ticket scheduled after Aurora DSQL lands.
- [x] Implement the export endpoint streaming `application/x-ndjson` (commit on Step 5). Round-trip test asserts each line `JSON.parse`s back to the original record (`history.controller.spec.ts`, `export-history.use-case.spec.ts`).
- [x] Forward-compat test: a record with an unknown field (`"future_field": 42`) round-trips through the reader and the field is dropped on re-emit (`history-record.spec.ts` — "strips unknown fields silently").
- [x] Unknown-version test: a record with `"v": 2` is rejected at the schema boundary so it cannot enter the store (`history-record.spec.ts` — "rejects an unknown schema version"). **Drop counter is deferred to the Postgres adapter follow-up** — the in-memory writer guarantees `v: 1`, so cross-version records cannot enter the in-memory store; the counter becomes meaningful only when records can be loaded from a persistent store written by a different build.
- [x] `ts` round-trip test: `new Date(parsed.ts).toISOString() === parsed.ts` is asserted in `history-record.spec.ts` ("preserves ts under Date round-trip").
- [x] Update [`project-status.md`](../project-status.md) and [`roadmap.md`](../roadmap.md) — entries added for "2026-06-05 / 0009-impl code complete on `feature/history-schema-mirror-impl`".

## Definition of Done

- [ ] Web records have the same per-record JSON shape as desktop's `history.jsonl` lines. A test fixture from desktop (one or two real records) parses cleanly via the web schema.
- [ ] `actor` is populated from the authenticated session for any logged-in request; `null` otherwise. Empty string is never emitted.
- [ ] `error` envelope categories are a subset of `{ connection, query, schema, type_conversion, capability }`. A test asserts no web-internal category leaks.
- [ ] Export endpoint streams `application/x-ndjson`. `curl … | jq -c .` is byte-identical to the input.
- [ ] Reader tolerates unknown fields and drops unknown-`v` / unknown-`status` records with an observable counter.
- [ ] Web ADR cites desktop ADR-0017 by anchor (file + commit + date), does not duplicate the schema text.
- [ ] `pnpm format:check`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] [`project-status.md`](../project-status.md) marks this issue done and points at the merge commit.

## Disposition

- This issue lands a docs-only mirror commit first (handoff brief + this file + status update). That commit unblocks the planner so they can pick up the implementation against `0003`/`0004` already on `develop`.
- Implementation work happens after [`0003`](./0003-nestjs-http-surface.md) and [`0004`](./0004-postgres-adapter.md) merge. Before then the `NullAdapter` does not produce meaningful `rows` / `rows_affected` / `duration_ms`, so the schema fields would carry placeholder values and the persistence layer would have nothing useful to test against a real `QueryResult`.

## References

- Cross-repo brief: [`../handoff/2026-06-04-history-schema-mirror-incoming.md`](../handoff/2026-06-04-history-schema-mirror-incoming.md)
- Desktop ADR-0017: `dbboard@62ed834:docs/decisions.md` (search `## ADR-0017`)
- Desktop reference implementation: `dbboard@72cb165:crates/dbboard-ui/src/history.rs`
- Desktop Stage 2 closeout: `dbboard@ae86627`
- Related web issues: [`0003`](./0003-nestjs-http-surface.md), [`0004`](./0004-postgres-adapter.md)
- Earlier mirrors: [`0001`](./0001-web-contract-mirror.md), [`0007`](./0007-web-contract-mirror-v2.md)
