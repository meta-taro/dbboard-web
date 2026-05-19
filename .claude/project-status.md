# Project status

> Living document. Update whenever a phase or major task changes state.

## Current phase

**Phase 0 — Bootstrap & rules**

Setting up project rules, documentation, and AI-agent working files before any application code is written.

## Completed

- Repository initialized (`develop` branch, `LICENSE` in place).
- Project rules captured in `CLAUDE.md`, `AI_AGENT_RULES.md`, `DESIGN.md`.
- `.claude/` working directory created with roadmap, decisions, and an initial bootstrap issue.

## In progress

- Awaiting decision to start **Phase 1 — Monorepo scaffold** (pnpm workspace, `frontend/` Nuxt app, `backend/` NestJS app, shared tsconfig, lint / format / typecheck scripts, husky + lint-staged hooks).

## Open questions

- Final choice of UI library and styling approach for Nuxt (Tailwind vs UnoCSS vs hand-rolled CSS variables).
- Initial database target for the end-to-end smoke test (Neon vs Supabase vs libSQL).
- AI provider plug-in interface shape (deferred until the core DB flow works).
- Coordination with the desktop client (`dbboard`) on shared types, query semantics, and parity expectations.

## Known constraints

- Not a production SaaS — clarity and extensibility take priority over feature completeness.
- AI must remain optional and decoupled from core DB modules.
- The web client is developed in parallel with the desktop client `dbboard` (https://github.com/meta-taro/dbboard). Both repositories started on 2026-05-19 with `LICENSE` only.

## Parallel development with `dbboard` (desktop)

The same maintainer ships both clients. Pace and sequencing implications:

- Maintainer attention is split — each phase is sized to be completable in a single focused session and must not leave either repo in a broken state if the maintainer context-switches.
- Both repos are at Phase 0 today; there is no legacy on either side, so domain concepts can be aligned from the outset at low cost.
- Recommended sequencing: build the NestJS backend in `dbboard-web` first (Phases 1–3). The same backend can later be reused by `dbboard` rather than reimplementing two independent backends.
- See [decisions.md](./decisions.md) for the full coordination policy.
