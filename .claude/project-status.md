# Project status

> Living document. Update whenever a phase or major task changes state.

## Current phase

**Phase 0 — Bootstrap & rules: complete.**

**Phase 1 — Monorepo scaffold: unblocked, not yet started.** The desktop client closed its Phase 1 / 1.5 / 1.6 / 1.7 at workspace `0.1.0` (2026-05-25) with a stable HTTP API contract. That contract has been mirrored into this repo as [`docs/api-contract.md`](../docs/api-contract.md). Phase 1 implementation work begins from that fixed target — see issue [`0001`](./issues/0001-web-contract-mirror.md) for the mirror and [`0002`](./issues/0001-web-contract-mirror.md#follow-up-issues-phase-1) onward for the implementation breakdown.

## Completed

- Repository initialized (`develop` branch, `LICENSE` in place).
- Project rules captured in `CLAUDE.md`, `AI_AGENT_RULES.md`, `DESIGN.md`.
- `.claude/` working directory created with roadmap, decisions, and an initial bootstrap issue.
- Cross-repo audit with `dbboard` desktop (2026-05-19): coordination policy revised, sequencing decided, Phase 0 DoD checks complete.
- **HTTP API contract mirrored from `dbboard` (2026-05-25):** [`docs/api-contract.md`](../docs/api-contract.md) snapshotted at `dbboard@89b7c70` (last contract change `3f114e4`, "publish the 10,000-row per-query cap"). See issue [`0001`](./issues/0001-web-contract-mirror.md) for provenance and scope.

## In progress

- **Issue [`0001`](./issues/0001-web-contract-mirror.md) — HTTP API contract mirror.** Documentation tasks complete; awaiting maintainer review and commit. Implementation work splits into follow-up issues `0002` (scaffold), `0003` (HTTP surface), `0004` (Postgres adapter), `0005` (row cap + conformance tests).

## Open questions

- Final choice of UI library and styling approach for Nuxt (Tailwind vs UnoCSS vs hand-rolled CSS variables).
- Initial database target for the end-to-end smoke test (Neon vs Supabase vs libSQL).
- AI provider plug-in interface shape (deferred until the core DB flow works).
- Concrete shape of the cross-client API contract (connection definition, query envelope, error category codes) — to be drafted once Phase 2 begins on either side.

## Known constraints

- Not a production SaaS — clarity and extensibility take priority over feature completeness.
- AI must remain optional and decoupled from core DB modules.
- A sibling project, `dbboard` (https://github.com/meta-taro/dbboard), is a **native Rust GUI** with its own **local Rust API**. It is an independent application — there is no runtime coupling and no shared code with `dbboard-web`.

## Relationship with `dbboard` (desktop, native Rust)

The same maintainer ships both clients, but they are independent applications:

- **No code is shared.** Each side writes idiomatic types, controllers, and UI in its own language.
- **The API contract is aligned by convention** — connection definitions, query envelopes, error categories, and AI provider request and response shapes use the same vocabulary on both sides.
- **User data formats interoperate** — exported connections and query history use a common JSON shape so a user can move state between desktop and web.
- **Independent schedules.** Either side may progress on any phase without waiting for the other. Phases are sized to be completable in a single focused session so context-switching never leaves either repo broken.
- See [decisions.md](./decisions.md) for the full policy.
