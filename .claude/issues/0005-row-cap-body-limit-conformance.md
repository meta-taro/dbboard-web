# 0005 — Row cap + body limit + contract-conformance test (Phase 2 / Phase 3 closeout)

- **Status:** open
- **Phase:** 2 / 3 (closeout)
- **Opened:** 2026-06-03
- **Closed:** —
- **Branch:** _to be created_ (`feature/phase-3-conformance` suggested)
- **Depends on:** [0003](./0003-nestjs-http-surface.md) (HTTP surface), [0004](./0004-postgres-adapter.md) (Postgres adapter to exercise)

## Goal

Close out the contract-conformance work that 0001 explicitly deferred. Three deliverables:

1. **Enforce the contract's 10,000-row cap** on every `executeQuery` path so the UI cannot silently see a truncated grid.
2. **Enforce the contract's 64 KiB body cap** on `POST /query` and `POST /connections/:id/query` so oversized bodies are rejected with `413 Payload Too Large` plain text before any handler runs.
3. **Run the same battery of requests against the desktop loopback server and the web service** and assert deep-equal responses (modulo `capabilities.id`). This is the cross-implementation drift detector — when desktop ships a new contract addition, this test fails until web mirrors it.

This ticket is the proof that "the contract is mirrored" actually holds at runtime, not just in `docs/api-contract.md`.

## Scope

### 1. Row cap — 10,000 rows per query

Per `docs/api-contract.md`:

> Each adapter caps a single query at **10,000 rows**. A statement that would return more is rejected with a `query` error (status `400`) so the UI never silently shows a truncated grid.

Implementation:

- The cap lives in the **use case** (`ExecuteQuery`), not in each adapter — that way no adapter can forget it.
- The use case awaits the adapter's row stream / array, checks length, and throws `QueryError("result exceeds the 10,000-row cap (got N)")` before returning.
- Postgres specifically: prefer setting a `LIMIT 10001` server-side via row-mode where feasible, then trim — keeps the worst case bounded even when the query returns gigabytes. If we keep the simple `pg.query()` path from 0004, document the memory caveat in the work log.
- Constant lives in `domain/limits.ts` as `ROW_CAP = 10_000`. The conformance test imports the same constant so a contract-side change updates both checks together.

### 2. Body cap — 64 KiB on `POST /query` family

Per `docs/api-contract.md` § Request-level rejections:

| Condition           | Status | Body       |
| ------------------- | ------ | ---------- |
| Body exceeds 64 KiB | `413`  | plain text |

Implementation:

- Nest's `bodyParser.json({ limit: '64kb' })` configured on the global app **only for the two query routes** so the connection-management endpoints can take larger payloads if needed.
- Override at the controller / module level with `RawBodyRequest` if Nest's default chains misbehave on plain text.
- Constant in `domain/limits.ts` as `QUERY_BODY_LIMIT_BYTES = 64 * 1024`.

### 3. Contract-conformance test

Lives under `apps/api/tests/conformance/`. Spawns the desktop loopback server (if available) and hits the same URLs on both servers.

**Sourcing the desktop server:**

- The desktop loopback binary path comes from `DBBOARD_SERVER_BIN` env var (matches desktop's existing convention — see `dbboard/crates/dbboard-server/README.md`).
- If unset, the test **skips** with a clear message; do **not** fail. CI runs it nightly via a workflow that downloads a pinned desktop build artifact.
- Spin up the desktop server on a random port; capture stdout / stderr so a flake is debuggable.

**Request battery:**

| Request                                                                                   | Why                                                                                                  |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `GET /health`                                                                             | Liveness baseline.                                                                                   |
| `GET /tables`                                                                             | Empty + populated cases.                                                                             |
| `GET /capabilities`                                                                       | Deep-equal modulo `id` (desktop returns adapter-specific id, web returns whatever adapter is wired). |
| `POST /query` with `{"sql":"SELECT 1 AS one"}`                                            | Happy path.                                                                                          |
| `POST /query` with `{"sql":"SELECT NULL::int, 1::int, 1.5::float, 'hi', '\\xff'::bytea"}` | Value union coverage — Null, Integer, Real, Text, Blob.                                              |
| `POST /query` with malformed JSON                                                         | 400 plain text on both sides.                                                                        |
| `POST /query` with `{"oops":1}`                                                           | 422 envelope (`query` category) on both sides.                                                       |
| `POST /query` with `Content-Type: text/plain`                                             | 415 plain text on both sides.                                                                        |
| `POST /query` with a 65 KiB body                                                          | 413 plain text on both sides.                                                                        |
| `POST /query` with `{"sql":"SELECT generate_series(1, 10001)"}`                           | 400 envelope (`query` category, message contains "10,000-row cap") on both sides.                    |
| `POST /query` with `{"sql":"SELECT 1/0"}`                                                 | 400 envelope (`query` category) — both sides report division by zero.                                |
| `GET /nonexistent`                                                                        | 404 — both sides return their framework's default.                                                   |

For each, the test:

1. Issues the request to desktop, records status code, body, content-type.
2. Issues the same request to web, records the same.
3. Asserts status codes equal.
4. Asserts content-types equal modulo charset suffix.
5. For JSON responses: deep-equal modulo allowed differences (`capabilities.id`).
6. For plain-text responses: case-insensitive substring assertion (the contract is silent on exact wording).

**Setup:** for the row-cap and divide-by-zero tests, both servers point at the same Postgres (testcontainers) so the same SQL produces the same upstream behavior.

## Tasks

- [ ] Constants in `apps/api/src/domain/limits.ts` (`ROW_CAP = 10_000`, `QUERY_BODY_LIMIT_BYTES = 65_536`).
- [ ] `ExecuteQuery` use case: enforce row cap, throw `QueryError` with the exact message text the contract expects.
- [ ] Nest bootstrap: 64 KiB body-parser limit on the two query routes. Custom Nest exception filter for the plain-text 413 (the default Nest filter wraps in JSON).
- [ ] Custom plain-text 400 filter for the malformed-JSON case (same — Nest's default wraps in JSON).
- [ ] Custom plain-text 415 filter for content-type rejection.
- [ ] Conformance test runner under `apps/api/tests/conformance/`:
  - [ ] Desktop server spawner (`DBBOARD_SERVER_BIN`), skip gate, port discovery.
  - [ ] Web server spawner (in-process Nest app on a random port).
  - [ ] Postgres fixture (shared between both servers via testcontainers).
  - [ ] Request-battery cases above.
  - [ ] Deep-equal helper that respects the `capabilities.id` carve-out.
- [ ] Update `.claude/project-status.md` and `.claude/roadmap.md` when this lands. Phase 2 + 3 are then both fully closed.
- [ ] If new contract additions surfaced since `dbboard@d7c58ad`, re-mirror first; document the snapshot pointer in the work log.

## Definition of Done

Per `roadmap.md` Phase 2 + Phase 3:

- [ ] A 10,001-row query is rejected with a `query` 400 envelope; the message text matches the contract intent (mentions "10,000-row cap").
- [ ] A 64 KiB + 1 body on `POST /query` returns `413 Payload Too Large` as plain text (not the Nest JSON envelope).
- [ ] Conformance test passes against desktop loopback when `DBBOARD_SERVER_BIN` is set; skips cleanly otherwise.
- [ ] The deep-equal comparison covers all eleven cases in the request battery.
- [ ] CI workflow (or a `pnpm` script — `pnpm conformance`) wires the test up so a maintainer can run it before merging contract-touching changes.
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.

## Verification

```sh
# Unit + integration (integration needs Docker).
pnpm -r test

# Conformance test — requires the desktop server binary and Docker.
export DBBOARD_SERVER_BIN=/path/to/dbboard-server
pnpm --filter @dbboard-web/api conformance

# Manual oversize body smoke.
pnpm --filter @dbboard-web/api start &
sleep 2
curl -sv -X POST http://localhost:4000/query \
  -H 'Content-Type: application/json' \
  --data-binary @<(python3 -c "print('{\"sql\":\"' + 'a'*70000 + '\"}')") \
  2>&1 | grep -E '(< HTTP|413)'
# Expect: HTTP/1.1 413 Payload Too Large + plain-text body.
```

## Notes

- The desktop side has an analogous conformance test (running web against desktop). When both exist, drift is detected from whichever direction the maintainer pushes first.
- Streaming / pagination as a relaxation of the row cap is **out of scope**. The contract docs themselves flag this as a Phase 2-relax item with an ADR pair across both sides; until that ADR lands, 10,000 is a hard ceiling.
- If the conformance test surfaces a mismatch that is not a web-side bug, the fix path is: file an ADR question on the desktop side, **never** patch the contract textually here. See `0001` § Notes.
- A future ticket may extract the conformance battery into a tiny standalone CLI so both repos consume the same test definition — for now the test lives inside `apps/api/tests/conformance/`.
