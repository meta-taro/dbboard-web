# Project status

> Living document. Update whenever a phase or major task changes state.

## Current phase

**Phase 0 — Bootstrap & rules: complete.**

**Phase 1 — Monorepo scaffold: complete (2026-05-25, merged 2026-05-26).** pnpm workspace, NestJS 11 API skeleton, Nuxt 4 web skeleton, shared tooling (ESLint flat config v9, Prettier, Vitest 3, Husky 9) and the full per-commit verification chain (`format:check`, `typecheck`, `lint`, `test`, `build`) all green. Landed via PR [#1](https://github.com/meta-taro/dbboard-web/pull/1), merge commit `1c204ed` on `develop`. Feature branch deleted local + remote.

**Web is paused on the contract track.** Per the original cross-repo sequencing (`dbboard@939fe22`), desktop now picks up Phase 2 — trait extraction + Capability + `/capabilities` endpoint. The contract-dependent web issues (`0003` HTTP surface, `0004` Postgres adapter, `0005` row cap + conformance) resume the moment desktop publishes the updated `docs/api-contract.md`. See [`handoff/2026-05-26-back-to-desktop-phase-2.md`](./handoff/2026-05-26-back-to-desktop-phase-2.md) for the outgoing brief.

**A parallel non-contract track opened on 2026-05-26 — Phase 1.5 PWA shell.** Desktop sent an incoming strategic brief ([`handoff/2026-05-26-pwa-pivot-incoming.md`](./handoff/2026-05-26-pwa-pivot-incoming.md)) settling the mobile question: no native `dbboard-mobile` repo; PWA-ify `dbboard-web` instead to cover ambient, read-mostly mobile use (think GitHub mobile app — glance at signup counts, verify an order, kill a stuck query). PWA work touches only the app shell, so it runs **in parallel with the contract wait**. Tracked as issue [`0006`](./issues/0006-pwa-shell.md).

## Completed

- Repository initialized (`develop` branch, `LICENSE` in place).
- Project rules captured in `CLAUDE.md`, `AI_AGENT_RULES.md`, `DESIGN.md`.
- `.claude/` working directory created with roadmap, decisions, and an initial bootstrap issue.
- Cross-repo audit with `dbboard` desktop (2026-05-19): coordination policy revised, sequencing decided, Phase 0 DoD checks complete.
- **HTTP API contract mirrored from `dbboard` (2026-05-25):** [`docs/api-contract.md`](../docs/api-contract.md) snapshotted at `dbboard@89b7c70` (last contract change `3f114e4`, "publish the 10,000-row per-query cap"). See issue [`0001`](./issues/0001-web-contract-mirror.md) for provenance and scope.
- **Branch policy and distribution model decided (2026-05-25):** `feature/<slug>` → PR → `develop` (matches desktop ADR-0005); self-host only OSS distribution via Docker Compose + ghcr.io, no maintainer-run SaaS. See [`decisions.md`](./decisions.md).
- **Phase 1 monorepo scaffold landed (2026-05-25):** pnpm@11.1.1 workspace (apps/api + apps/web), NestJS 11 with a smoke `GET /health` controller, Nuxt 4 with a smoke page, shared ESLint flat config, Prettier, Vitest 3 (api + happy-dom/nuxt environments), Husky 9 pre-commit (lint-staged) and pre-push (typecheck + lint + test + build). Full verification chain green. See issue [`0002`](./issues/0002-monorepo-scaffold.md).
- **Phase 1 merged (2026-05-26):** PR [#1](https://github.com/meta-taro/dbboard-web/pull/1) merged to `develop` as `1c204ed`. `feature/phase-1-bootstrap` branch deleted local + remote. Follow-up `chore: migrate pnpm settings to pnpm-workspace.yaml` (settings home moved per pnpm 11 deprecation) included in the same PR.

## In progress

- **Phase 1.5 — PWA shell** (issue [`0006`](./issues/0006-pwa-shell.md)). Just opened; no implementation yet. This phase runs in parallel with the contract wait — it does not unblock or block `0003`/`0004`/`0005`.

## Waiting

- Contract follow-ups `0003`/`0004`/`0005` are blocked on desktop publishing the next `docs/api-contract.md` change (Phase 2 / `/capabilities`). See [`handoff/2026-05-26-back-to-desktop-phase-2.md`](./handoff/2026-05-26-back-to-desktop-phase-2.md).

## Resume triggers

Pick up web work again when **any** of these happen:

- Desktop commits a `feat(contract): ...` or `docs(api-contract): ...` change to `dbboard/docs/api-contract.md` — re-mirror to `dbboard-web/docs/api-contract.md` and start issue `0003`.
- Desktop emits a new `chore(handoff): ...` brief in `dbboard/` — read it and translate into a new web issue under `.claude/issues/`.
- A maintainer-driven web-only change is required (e.g., security patch, dependency bump).

To check: `cd ../dbboard && git log --oneline main..HEAD` and look for `(contract)`, `(handoff)`, or release-tag commits since `0b68aad` (the desktop tip when web paused).

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
