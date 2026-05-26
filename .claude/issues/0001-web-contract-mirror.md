# 0001 — HTTP API contract mirror

- **Status:** in-progress
- **Phase:** 1 (precondition — runs before NestJS scaffolding)
- **Opened:** 2026-05-25
- **Source brief:** `dbboard/.claude/issues/0001-web-contract-mirror.md` (commit `939fe22`)
- **Source contract:** `dbboard/docs/api-contract.md` (last touched at commit `3f114e4`, stable in `dbboard` HEAD `89b7c70`)

## Goal

Mirror the canonical `dbboard` HTTP API contract into this repository so the upcoming NestJS service has a fixed target before any application code is written. The two clients stay aligned per the "shared contract, separate implementations" policy (see [.claude/decisions.md — Relationship with `dbboard`](../decisions.md)).

The desktop side closed Phase 1 at workspace `0.1.0` with a stable contract. Per their `ADR-0011`, the `dbboard@1.0.0` release blocks on interop with `dbboard-web`, which places this mirror on the critical path. Mirroring now is forward-compatible: the desktop's Phase 2 work (capability model, `GET /capabilities`, `capability` error category) is **purely additive** to the current three endpoints and will be re-mirrored when it lands.

## Tasks

- [x] Snapshot `dbboard/docs/api-contract.md` at `HEAD` (`89b7c70`) into `docs/api-contract.md` here. Content-identical; line endings normalized to LF to match repo convention.
- [x] Cross-link the mirror from `.claude/decisions.md` so contract evolution flows through the ADR log on both sides.
- [x] Update `.claude/project-status.md` to mark contract mirror in progress and Phase 1 scaffold as unblocked.
- [x] Update `.claude/roadmap.md` to reference the mirrored contract as Phase 1 input.
- [ ] _(Out of scope for this issue — graduates to follow-up issues):_ NestJS service implementation, Postgres adapter, contract-conformance tests, body-parser limit, 10,000-row cap. See "Follow-up issues" below.

## Definition of Done

- [x] `docs/api-contract.md` exists in this repo and is content-identical to the desktop snapshot (LF vs CRLF differences only).
- [x] `.claude/decisions.md` records the contract-mirror ADR pointing to desktop ADR-0004 / ADR-0006 / ADR-0009 / ADR-0011 as canonical references.
- [x] `.claude/project-status.md` reflects the new state (Phase 0 still complete; Phase 1 unblocked with the contract as input).
- [x] `.claude/roadmap.md` references `docs/api-contract.md` from Phase 1 onward.
- [ ] Maintainer review and commit (commits authored by the agent, push reserved for the human per `AI_AGENT_RULES.md` §6).

## Verification

```sh
# Content-identity check between desktop and web mirrors (LF-normalized).
diff -u \
  <(tr -d '\r' < ../dbboard/docs/api-contract.md) \
  <(tr -d '\r' < docs/api-contract.md) \
  && echo CONTENT-IDENTICAL

# Repo hygiene.
git status
git diff --stat HEAD
```

Tooling-level verification (`pnpm lint && pnpm typecheck && pnpm test:run`) is deferred until Phase 1 scaffolding lands; this issue ships only documentation.

## Scope (what is being mirrored)

The mirror covers the desktop contract surface as of `dbboard@89b7c70`:

- **Endpoints:** `GET /health`, `GET /tables`, `POST /query`.
- **Data shapes:** `Value` (Null / Integer / Real / Text / Blob with `{ "$blob": "<base64>" }`), `QueryResult`, `Column`, `TableInfo`.
- **Error envelope:** `{ "error": { "category", "message" } }` with `query` (400), `type_conversion` (422), `connection` (502), `schema` (502). Unknown categories degrade to `query` on the client side.
- **Request-level rejections** (plain-text body, not envelope): invalid JSON → 400, missing `sql` → 422, wrong `Content-Type` → 415, body > 64 KiB → 413.
- **Row cap:** 10,000 rows per query, uniformly across adapters. Over-cap returns a `query` 400 (never a silent truncation).

## Out of scope (intentionally deferred)

- `GET /capabilities` and the `capability` error category — these come from desktop ADR-0012 and **do not exist in desktop code yet**. They will be added contract-first on the desktop, then re-mirrored here. Do not pre-implement.
- AI provider endpoints — covered by web Phase 6 and not in the contract.
- Streaming / pagination as a row-cap escape hatch — separate ADR on the desktop side.

## Follow-up issues (Phase 1+)

The desktop brief's Acceptance criteria (NestJS service, Postgres adapter, conformance tests, body limit, row cap) graduate into subsequent issues so each can ship as a small, reviewable phase:

- `0002` — Monorepo scaffold (pnpm workspace, empty Nuxt + NestJS apps, husky hooks, pinned `packageManager`).
- `0003` — NestJS HTTP surface: `GET /health`, `GET /tables`, `POST /query` with validation (class-validator for the 422 vs 400 split) and request-level rejections.
- `0004` — Postgres adapter (`pg` or `postgres.js`), `sslmode=prefer` → `require`, dynamic text-format decoding to `Value`.
- `0005` — 10,000-row cap enforcement + body-parser limit + contract-conformance test (runs the same requests against the desktop loopback and the web service, compares responses).

## Work log

- **2026-05-25** — Issue opened. Desktop brief (`dbboard@939fe22`) and contract (`dbboard@89b7c70` HEAD, last-touched at `3f114e4`) snapshotted into this repo.
  - Created `docs/api-contract.md` (content-identical to desktop, LF endings).
  - Updated `.claude/project-status.md`, `.claude/roadmap.md`, `.claude/decisions.md` to record the mirror and unblock Phase 1.
  - Implementation issues (`0002`–`0005`) listed above and will be opened as their predecessor lands.

## Notes

- Contract evolution flows through the desktop side first (per their ADR-0004). When the contract changes, the desktop drafts the diff in `dbboard/docs/api-contract.md`, then re-mirrors here. Do not introduce contract-level changes unilaterally from the web side — file an issue on the desktop repo first.
- If an ambiguity in the mirrored contract is discovered while implementing the NestJS service, file it back as a desktop-side ADR question rather than diverging silently.
