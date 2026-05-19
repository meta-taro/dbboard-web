# 000 — Bootstrap: project rules and AI-agent context

## Goal

Establish the working agreement, documentation skeleton, and AI-agent working files before any application code is written, so that every subsequent change inherits a consistent set of rules.

## Tasks

- [x] Write `CLAUDE.md` (overview and pointers).
- [x] Write `AI_AGENT_RULES.md` (detailed rules).
- [x] Write `README.md` (project intro for humans).
- [x] Write `DESIGN.md` (placeholder, refined when UI work begins).
- [x] Initialize `.claude/` with `project-status.md`, `roadmap.md`, `decisions.md`, and this issue.
- [x] Add a `.gitignore` covering Node.js, Nuxt, NestJS, IDEs, OS metadata, and secrets.
- [x] Maintainer review and merge (2026-05-19, cross-repo audit with `dbboard`).

## Definition of Done

- All files above exist in the repository.
- Cross-links between files resolve (no broken relative links).
- `git status` is clean after staging.
- Maintainer has confirmed the rules match their intent.

## Verification

```sh
git status
git diff --stat HEAD
# Once tooling exists (Phase 1):
# pnpm lint && pnpm typecheck
```

## Work log

- 2026-05-19 — Issue created and bootstrap files drafted.
- 2026-05-19 — Cross-repo audit with `dbboard` desktop: coordination policy revised to "shared HTTP API contract, separate implementations" (desktop ADR-0004 revised, ADR-0006 added). Initial sequencing decision recorded: `dbboard` Phase 1 runs first. Phase 0 maintainer review complete.
