# Project status

> Living document. Update whenever a phase or major task changes state.

## Current phase

**Phase 0 — Bootstrap & rules: complete.**

**Phase 1 — Monorepo scaffold: complete (2026-05-25, merged 2026-05-26).** pnpm workspace, NestJS 11 API skeleton, Nuxt 4 web skeleton, shared tooling (ESLint flat config v9, Prettier, Vitest 3, Husky 9) and the full per-commit verification chain (`format:check`, `typecheck`, `lint`, `test`, `build`) all green. Landed via PR [#1](https://github.com/meta-taro/dbboard-web/pull/1), merge commit `1c204ed` on `develop`. Feature branch deleted local + remote.

**Contract wait lifted on 2026-05-27.** Desktop completed Phase 2 (ADR-0012 Capability pattern + `GET /capabilities`) and merged PR #5 as `dbboard@d7c58ad`. The web-bound mirror brief landed in `dbboard/.claude/issues/0002-web-capabilities-mirror.md` at desktop commit `f59107b`, capturing what to mirror and why. Receipt recorded at [`handoff/2026-05-27-contract-mirror-v2-incoming.md`](./handoff/2026-05-27-contract-mirror-v2-incoming.md). The implementation issues `0003` (HTTP surface), `0004` (Postgres adapter), `0005` (conformance) pick up the Phase 2 surface when they start; their DoD now covers `GET /capabilities`, the `Capabilities` shape, and the `capability` 404 envelope. Desktop's outgoing brief noted "desktop はしばらく contract change を待つフェーズ" — baton is on the web side.

**Phase 1.5 PWA shell — code-side merged on 2026-06-03.** PR [#4](https://github.com/meta-taro/dbboard-web/pull/4) merged to `develop` as `e1b490a`; `feature/phase-1.5-pwa-shell` deleted local + remote. The Nuxt app is installable as a PWA: manifest, auto-updating service worker, `/offline` fallback, iOS Safari head meta, opt-in `useInstallPrompt`, mobile-first responsive baseline. Four real-device acceptance items (Android Chrome A2HS, iOS Safari standalone, Lighthouse PWA ≥ 90, offline cold start) remain pending the maintainer per issue [`0006`](./issues/0006-pwa-shell.md); when they pass, the `chore(handoff): ...` brief back to desktop fires per § Handback. Incoming strategic brief for the PWA pivot is at [`handoff/2026-05-26-pwa-pivot-incoming.md`](./handoff/2026-05-26-pwa-pivot-incoming.md) (no native `dbboard-mobile` repo; PWA-ify `dbboard-web` instead).

**Phase 2.5 Multilingual UI Stage 1 — in progress on `feature/phase-2.5-i18n` (2026-06-03).** Mirrors desktop ADR-0015 that shipped earlier the same day. `@nuxtjs/i18n@^10.4.0` wired into `apps/web`, 11 JSON locale files (`en` / `ja` / `ko` / `zh-CN` / `zh-TW` / `de` / `fr` / `es` / `pt-BR` / `ru` / `it`) under `apps/web/i18n/locales/`, `<html lang>` reactive to the active locale, `LocaleSwitcher` in the header, resolution priority `?lang=` > `dbboard_lang` cookie > `Accept-Language` > `en` (the query-param leg enforced by a global route middleware). No HTTP contract change — `apps/api` continues to return the error envelope in English per ADR-0009 + desktop ADR-0015. Decision recorded as `.claude/decisions.md` "2026-06-03 — Multi-language UI support (Stage 1, 11 locales)" and tracked by issue [`0008`](./issues/0008-i18n-stage-1.md). Parallel to Phase 2 backend work — different files, no merge conflicts expected.

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
- **Contract mirror v2 merged (2026-05-27):** PR [#3](https://github.com/meta-taro/dbboard-web/pull/3) merged to `develop` as `387f217`. Docs-only — mirrors the Phase 2 contract additions (`GET /capabilities`, `Capabilities` shape, `capability` 404 envelope) from desktop into `docs/api-contract.md`. Implementation flows into `0003`/`0004`/`0005` when they start.
- **Phase 1.5 PWA shell code merged (2026-06-03):** PR [#4](https://github.com/meta-taro/dbboard-web/pull/4) merged to `develop` as `e1b490a`. 5 commits — `@vite-pwa/nuxt` wired, manifest extracted to `apps/web/app/pwa/manifest.ts`, icon set generated from `public/icons/source.svg`, offline fallback at `/offline`, iOS Safari head meta, opt-in `useInstallPrompt` composable, mobile-first responsive baseline, 20 / 20 tests green. `feature/phase-1.5-pwa-shell` deleted local + remote. **Not yet fully closed** — four real-device DoD items still pending the maintainer (Android Chrome A2HS, iOS Safari standalone, Lighthouse ≥ 90, offline cold start). When they pass, the `chore(handoff): ...` brief back to desktop fires per [`0006` § Handback](./issues/0006-pwa-shell.md#handback).

## In progress

- **[`0003`](./issues/0003-nestjs-http-surface.md) — NestJS HTTP surface (Phase 2 + Phase 3 controllers).** Branch `feature/phase-2-http-surface`, code complete on 2026-06-03 and pending PR. All seven endpoints (`/health`, `/tables`, `/capabilities`, `/query`, `POST /connections`, `GET /connections`, `DELETE /connections/:id`, `POST /connections/:id/query`) behind a `NullAdapter` over the layered architecture (`domain` / `usecase` / `infrastructure` / `presentation`). `class-validator` + global `ValidationPipe` produces the 422 envelope on missing/wrong-type `sql`; bespoke `contentTypeGuard` middleware ahead of the body parser produces 415 for non-JSON; `app.useBodyParser('json', { limit: MAX_BODY_BYTES })` provides the seam 0005 will lock to 64 KiB. 78 tests across 22 files green; full verification chain green.
- **[`0008`](./issues/0008-i18n-stage-1.md) — Multi-language UI Stage 1 (Phase 2.5).** Branch `feature/phase-2.5-i18n`. Mirrors desktop ADR-0015 (2026-06-03) into `apps/web`: `@nuxtjs/i18n` + 11 JSON locales + `?lang=` / cookie / Accept-Language resolution + `LocaleSwitcher`. No HTTP contract change.

## Ready to start

- **[`0004`](./issues/0004-postgres-adapter.md) — Postgres adapter (Phase 2 / 3).** First real `DatabaseAdapter` implementation using `pg` + `testcontainers`. Drops in behind the `DATABASE_ADAPTER` token next to `NullAdapter`. Suggested branch `feature/phase-2-postgres-adapter`.
- **[`0005`](./issues/0005-row-cap-body-limit-conformance.md) — Row cap + body limit + contract-conformance test (Phase 2 / 3 closeout).** Enforces the contract's 10k-row cap and locks `MAX_BODY_BYTES` (0003 seam) at 64 KiB, plus a cross-implementation conformance battery against the desktop loopback server. Suggested branch `feature/phase-3-conformance`.

All three picked up `GET /capabilities`, the `Capabilities` shape, and the `capability` 404 envelope as part of their DoD per the v2 mirror.

## Resume triggers

Pick up web work again when **any** of these happen:

- Desktop commits a `feat(contract): ...` or `docs(api-contract): ...` change to `dbboard/docs/api-contract.md` — re-mirror to `dbboard-web/docs/api-contract.md` and start issue `0003`.
- Desktop emits a new `chore(handoff): ...` brief in `dbboard/` — read it and translate into a new web issue under `.claude/issues/`.
- A maintainer-driven web-only change is required (e.g., security patch, dependency bump).
- The four real-device DoD items for `0006` pass — write the `chore(handoff): ...` brief back to desktop and close the issue.

To check desktop progress: `cd ../dbboard && git log --oneline d7c58ad..HEAD` and look for `(contract)`, `(handoff)`, or release-tag commits.

**Desktop snapshot as of 2026-06-03:** desktop tip is `0b3f133`; 6 commits past `d7c58ad`, all on the **config layer** (ADR-0013: TOML connection store + keyring-backed secrets + env-var override, merged via desktop PR #6). **No `docs/api-contract.md` changes, no `.claude/handoff/` changes** — the web-side contract mirror v2 is still current and no incoming brief is waiting on the web side. The contract baton is still on the web side per the 2026-05-27 hand-off.

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
