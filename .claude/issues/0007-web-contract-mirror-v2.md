# 0007 — Web contract mirror v2 (Phase 2 additions)

- **Status:** open
- **Phase:** contract mirror (between Phase 1 and Phase 2 web implementation)
- **Opened:** 2026-05-27
- **Closed:** —
- **Branch:** `feature/contract-mirror-v2`
- **Depends on:** [0001](./0001-web-contract-mirror.md) (the original mirror)
- **Unblocks:** [0003](./_reserved.md), [0004](./_reserved.md), [0005](./_reserved.md) (the implementation issues — see Disposition below)

## Goal

Mirror the Phase 2 contract additions from desktop into `dbboard-web/docs/api-contract.md` so both repos describe the same wire surface. **Docs only.** Implementation lives in the reserved follow-up issues (`0003` HTTP surface, `0004` Postgres adapter, `0005` conformance test extension).

This issue is the web-side response to desktop's handoff brief, captured verbatim in [`../handoff/2026-05-27-contract-mirror-v2-incoming.md`](../handoff/2026-05-27-contract-mirror-v2-incoming.md).

## Snapshot pointer

- **Mirroring from:** `dbboard@d7c58ad` (merge of PR #5, which includes `1c350f6` "feat(server): add GET /capabilities and the capability error category" plus the docs commit `f59107b` "docs: document GET /capabilities and queue web mirror brief").
- **Previous mirror:** `dbboard@89b7c70` (last contract change `3f114e4`, see issue [`0001`](./0001-web-contract-mirror.md)).

## Scope

Strictly additive — Phase 2 changes no existing endpoint or shape. Three additions:

1. **Endpoint `GET /capabilities`.** Returns `{ id, capabilities }`. The `id` is a lowercase adapter-stable string (`"turso"`, `"d1"`, `"postgres"`). The `capabilities` payload is a flat snake_case boolean object. Forward-compat: clients tolerate unknown flags.
2. **Data shape `Capabilities`.** Flat object of `snake_case` boolean flags — `has_views`, `has_functions`, `has_auth`, `has_storage`, `has_realtime`. Phase 2 ships all flags as `false`; later phases flip them alongside per-feature endpoints.
3. **Error category `capability`.** Maps to HTTP `404 Not Found`. Used when the caller hits a feature the adapter does not implement. Same envelope (`{ "error": { "category": "capability", "message": "..." } }`).

## Out of scope (intentionally)

- **NestJS implementation** of `/capabilities` — that lives in issue `0003`/`0004`. This issue only updates docs.
- **Per-feature endpoints** (`/views`, `/functions`, `/auth/*`, `/storage/*`, `/realtime/*`) — reserved by ADR-0012 but sequenced behind flag flips in later phases.
- **Capability negotiation** by the client. The additive flat object is the negotiation mechanism — clients filter on read.
- **Conformance test extension** for `/capabilities` — folded into `0005` when that ships.
- **Mobile / PWA work** — orthogonal track, see issue [`0006`](./0006-pwa-shell.md).

## Tasks

- [x] Read desktop's brief at `dbboard@f59107b:.claude/issues/0002-web-capabilities-mirror.md`.
- [x] Capture the brief verbatim into [`../handoff/2026-05-27-contract-mirror-v2-incoming.md`](../handoff/2026-05-27-contract-mirror-v2-incoming.md).
- [ ] Add `### GET /capabilities` section to `docs/api-contract.md`, placed between `GET /tables` and `POST /query` (matches desktop ordering at `1c350f6`).
- [ ] Add `### Capabilities` data shape under `## Data Shapes`, placed after `TableInfo` (matches desktop ordering).
- [ ] Add `capability` row to the `### Categories and statuses` table in `## Errors`.
- [ ] Update `.claude/project-status.md`: contract wait is lifted; record receipt of the incoming brief and the new snapshot pointer.
- [ ] Update `.claude/roadmap.md`: clarify that the docs mirror precedes implementation phases and link issues `0003`/`0004`/`0005` to the new contract surface.

## Definition of Done

- [ ] `docs/api-contract.md` contains the three Phase 2 additions and is **textually identical** to the desktop file at `1c350f6` for those three sections (`/capabilities` endpoint, `Capabilities` shape, `capability` error row). Modulo formatting that prettier insists on.
- [ ] Snapshot pointer recorded in `.claude/project-status.md` (`dbboard@d7c58ad`).
- [ ] Phase 1 contract surface is untouched — no diff to `/health`, `/tables`, `/query`, `Value`, `QueryResult`, `Column`, `TableInfo`, or the existing error categories.
- [ ] `pnpm format:check`, `pnpm -r lint`, `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] [`.claude/project-status.md`](../project-status.md) marks this issue done and points at the merge commit.

## Disposition: how this issue relates to 0003/0004/0005

The original web roadmap reserved three issues for "post-Phase-1 contract follow-ups" while waiting on `/capabilities`. With the contract now mirrored:

- `0003` (NestJS HTTP surface): grows to include `GET /capabilities` alongside the Phase 1 endpoints when implementation starts.
- `0004` (Postgres adapter): the Postgres adapter must expose a `getCapabilities()` returning the flat shape (all `false` in Phase 2).
- `0005` (row cap + body limit + conformance tests): the conformance test from `0001` is extended to call `GET /capabilities` against both the desktop loopback server and the web service and assert deep equality modulo `id`.

The DoD of `0003`/`0004`/`0005` gets a Phase 2 surface bullet when each is started; nothing else changes structurally.

## References

- Incoming brief: [`../handoff/2026-05-27-contract-mirror-v2-incoming.md`](../handoff/2026-05-27-contract-mirror-v2-incoming.md)
- Desktop contract source: `dbboard@1c350f6:docs/api-contract.md` (lines added: `### GET /capabilities`, `### Capabilities`, `capability` error row).
- Desktop ADR-0012 (Capability pattern): `dbboard/docs/decisions.md`.
- Original web mirror: [`0001`](./0001-web-contract-mirror.md).
