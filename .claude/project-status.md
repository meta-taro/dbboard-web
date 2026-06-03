# Project status

> Living document. Update whenever a phase or major task changes state.

## Current phase

**Phase 0 — Bootstrap & rules: complete.**

**Phase 1 — Monorepo scaffold: complete (2026-05-25, merged 2026-05-26).** pnpm workspace, NestJS 11 API skeleton, Nuxt 4 web skeleton, shared tooling (ESLint flat config v9, Prettier, Vitest 3, Husky 9) and the full per-commit verification chain (`format:check`, `typecheck`, `lint`, `test`, `build`) all green. Landed via PR [#1](https://github.com/meta-taro/dbboard-web/pull/1), merge commit `1c204ed` on `develop`. Feature branch deleted local + remote.

**Contract wait lifted on 2026-05-27.** Desktop completed Phase 2 (ADR-0012 Capability pattern + `GET /capabilities`) and merged PR #5 as `dbboard@d7c58ad`. The web-bound mirror brief landed in `dbboard/.claude/issues/0002-web-capabilities-mirror.md` at desktop commit `f59107b`, capturing what to mirror and why. Receipt recorded at [`handoff/2026-05-27-contract-mirror-v2-incoming.md`](./handoff/2026-05-27-contract-mirror-v2-incoming.md). The implementation issues `0003` (HTTP surface), `0004` (Postgres adapter), `0005` (conformance) pick up the Phase 2 surface when they start; their DoD now covers `GET /capabilities`, the `Capabilities` shape, and the `capability` 404 envelope. Desktop's outgoing brief noted "desktop はしばらく contract change を待つフェーズ" — baton is on the web side.

**A parallel non-contract track is still open — Phase 1.5 PWA shell.** Desktop sent an incoming strategic brief on 2026-05-26 ([`handoff/2026-05-26-pwa-pivot-incoming.md`](./handoff/2026-05-26-pwa-pivot-incoming.md)) settling the mobile question: no native `dbboard-mobile` repo; PWA-ify `dbboard-web` instead to cover ambient, read-mostly mobile use (think GitHub mobile app — glance at signup counts, verify an order, kill a stuck query). PWA work touches only the app shell, so it runs **independently of the contract track**. Tracked as issue [`0006`](./issues/0006-pwa-shell.md).

## Completed

- Repository initialized (`develop` branch, `LICENSE` in place).
- Project rules captured in `CLAUDE.md`, `AI_AGENT_RULES.md`, `DESIGN.md`.
- `.claude/` working directory created with roadmap, decisions, and an initial bootstrap issue.
- Cross-repo audit with `dbboard` desktop (2026-05-19): coordination policy revised, sequencing decided, Phase 0 DoD checks complete.
- **HTTP API contract mirrored from `dbboard` (2026-05-25):** [`docs/api-contract.md`](../docs/api-contract.md) snapshotted at `dbboard@89b7c70` (last contract change `3f114e4`, "publish the 10,000-row per-query cap"). See issue [`0001`](./issues/0001-web-contract-mirror.md) for provenance and scope.
- **HTTP API contract mirror v2 — Phase 2 additions (2026-05-27):** Re-snapshotted at `dbboard@d7c58ad` (last contract change `1c350f6`, "feat(server): add GET /capabilities and the capability error category"). Three additive surfaces: `GET /capabilities` endpoint, `Capabilities` flat shape, `capability` error category (HTTP 404). The web `docs/api-contract.md` is now textually identical to the desktop file at the snapshot point. See issue [`0007`](./issues/0007-web-contract-mirror-v2.md) for provenance and scope; incoming brief at [`handoff/2026-05-27-contract-mirror-v2-incoming.md`](./handoff/2026-05-27-contract-mirror-v2-incoming.md).
- **Branch policy and distribution model decided (2026-05-25):** `feature/<slug>` → PR → `develop` (matches desktop ADR-0005); self-host only OSS distribution via Docker Compose + ghcr.io, no maintainer-run SaaS. See [`decisions.md`](./decisions.md).
- **Phase 1 monorepo scaffold landed (2026-05-25):** pnpm@11.1.1 workspace (apps/api + apps/web), NestJS 11 with a smoke `GET /health` controller, Nuxt 4 with a smoke page, shared ESLint flat config, Prettier, Vitest 3 (api + happy-dom/nuxt environments), Husky 9 pre-commit (lint-staged) and pre-push (typecheck + lint + test + build). Full verification chain green. See issue [`0002`](./issues/0002-monorepo-scaffold.md).
- **Phase 1 merged (2026-05-26):** PR [#1](https://github.com/meta-taro/dbboard-web/pull/1) merged to `develop` as `1c204ed`. `feature/phase-1-bootstrap` branch deleted local + remote. Follow-up `chore: migrate pnpm settings to pnpm-workspace.yaml` (settings home moved per pnpm 11 deprecation) included in the same PR.

## In progress

- **Contract mirror v2** (issue [`0007`](./issues/0007-web-contract-mirror-v2.md)). Docs-only PR on branch `feature/contract-mirror-v2`. Mirrors the Phase 2 contract additions from desktop into `docs/api-contract.md`. No implementation in this PR; that flows into `0003`/`0004`/`0005`.
- **Phase 1.5 — PWA shell** (issue [`0006`](./issues/0006-pwa-shell.md)). Branch `feature/phase-1.5-pwa-shell` opened 2026-06-03. Code-side DoD complete: `@vite-pwa/nuxt` wired, `apps/web/public/manifest.json` shipped via the module with all required fields, icon set generated from `public/icons/source.svg` (192/512 + maskable 512 + apple-touch 180), offline fallback at `/offline`, iOS Safari head meta set, opt-in `useInstallPrompt` composable, mobile-first responsive baseline on the smoke shell. Full verification chain green (`format:check`, `typecheck`, `lint`, `test`, `build`); the build emits `.output/public/manifest.webmanifest` + `sw.js`. Remaining DoD items are real-device acceptance only — Android Chrome installability check, iOS Safari standalone launch, Lighthouse PWA score ≥ 90, offline cold-start verification — and require the maintainer to run them before this can be closed.

## Ready to start

- **`0003` (NestJS HTTP surface)**, **`0004` (Postgres adapter)**, **`0005` (row cap + body limit + conformance test)** are unblocked now that the contract is mirrored at v2. Their DoD picks up the Phase 2 surface (`GET /capabilities`, `Capabilities` shape, `capability` 404 envelope) when each starts.

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
