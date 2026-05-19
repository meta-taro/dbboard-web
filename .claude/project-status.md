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
