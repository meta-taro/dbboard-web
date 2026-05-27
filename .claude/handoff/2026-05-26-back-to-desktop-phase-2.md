# Handoff back to desktop — dbboard-web side paused (2026-05-26)

Outgoing brief, mirror of the format used by `dbboard@939fe22`. Companion to
[`../project-status.md`](../project-status.md).

## What changed on the web side since the contract-mirror handoff (`dbboard@939fe22`)

- **Phase 1 closed.** Monorepo scaffold (pnpm workspace + Nuxt 4 + NestJS 11
  with a smoke `GET /health`) landed via PR [#1](https://github.com/meta-taro/dbboard-web/pull/1),
  merge commit `1c204ed` on `develop`. Feature branch deleted local + remote.
- **Contract mirror complete.** `docs/api-contract.md` on web is
  byte-content-identical to `dbboard@89b7c70` (last contract change
  `3f114e4`). Web's `.prettierignore` protects it from reformatting.
- **Three policy ADRs** landed in `.claude/decisions.md` on web:
  1. Adopt `dbboard` HTTP API contract as Phase 1 input.
  2. Branch policy: `feature/<slug>` → PR → `develop`
     (mirrors desktop ADR-0005).
  3. Self-host-only OSS distribution (Docker Compose + ghcr.io,
     no maintainer-run SaaS).
- **Web is now in wait state.** Issues `0003` (NestJS HTTP surface implementing
  the contract), `0004` (Postgres adapter), `0005` (row cap + body limit +
  conformance tests) are open but unattended until desktop publishes the next
  contract change.

## What desktop should pick up next

Per original sequencing in `dbboard@939fe22`: **Phase 2 — trait extraction +
Capability + `/capabilities` endpoint.**

Two coordination notes:

1. **Branch state.** Desktop is currently on `feature/dev-hardening-husky-deny`
   (49 files / +10,778 vs `main` at the time web paused). Decide before
   starting Phase 2 whether to land that branch first or queue it. Phase 2
   will edit the public contract, so doing it on top of a long-lived branch
   invites merge churn.

2. **When `/capabilities` lands on desktop, please:**
   - Update `docs/api-contract.md` on desktop in a clearly-named commit
     (`feat(contract): ...`).
   - Emit a handoff brief to `dbboard-web` in the same format as
     `dbboard@939fe22` so the next web session has marching orders. The web
     mirror will need re-syncing, and the queued web issues (`0003`–`0005`,
     possibly a new `0006`) will need to know what changed.

Web will resume the moment desktop publishes the contract update.
