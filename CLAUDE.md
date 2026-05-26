# CLAUDE.md

Guidance for Claude Code and other AI agents working on this repository.

## Project

**dbboard-web** is a modern multi-database web client with pluggable AI providers — the browser-based counterpart of the `dbboard` desktop client.

- **Frontend:** Nuxt (Vue 3, TypeScript)
- **Backend:** NestJS (Node.js, TypeScript)
- **Databases:** Neon (PostgreSQL), Supabase, Turso / libSQL
- **Package manager:** pnpm (npm and yarn are forbidden — see [AI_AGENT_RULES.md](./AI_AGENT_RULES.md))

```
User → Nuxt UI → NestJS API → Database
```

All database access flows through the backend API layer. AI integration is optional and must not be tightly coupled to database logic.

## Where to look

| File                                                     | Purpose                                                |
| -------------------------------------------------------- | ------------------------------------------------------ |
| [AI_AGENT_RULES.md](./AI_AGENT_RULES.md)                 | Full rules (TDD, layering, commits, tooling, security) |
| [DESIGN.md](./DESIGN.md)                                 | Visual direction, colors, layout, UI patterns          |
| [README.md](./README.md)                                 | Human-facing project introduction                      |
| [.claude/project-status.md](./.claude/project-status.md) | Current phase and open work                            |
| [.claude/roadmap.md](./.claude/roadmap.md)               | Phases and completion criteria                         |
| [.claude/decisions.md](./.claude/decisions.md)           | Technical decisions and rationale                      |
| [.claude/issues/](./.claude/issues/)                     | Work tickets                                           |

## Core rules (summary — see AI_AGENT_RULES.md for details)

1. **TDD.** Add a failing test before changing behavior. Minimal implementation, then refactor.
2. **pnpm only.** Never run `npm` or `yarn`. Never generate `package-lock.json` or `yarn.lock`.
3. **Layered architecture.** Keep business logic out of controllers and API routes. Layers: `domain` / `usecase` / `infrastructure` / `presentation` / `tests`.
4. **AI is optional.** Core database features must work with the AI module disabled.
5. **Commits are AI-authored, pushes are human-authored.** Commit per phase in small steps. Never run `git push` from an AI agent.
6. **Run before committing**: format, lint, typecheck, unit tests.
7. **Keep docs in sync with code.** README, DESIGN.md, and `.claude/*` must not drift from the implementation.
8. **No hardcoded secrets.** Use environment variables; provide a `.env.example`.

## Language convention

All files in this repository (markdown, code comments, commit messages, PR titles and bodies) are written in **English** — this is an OSS project. Direct dialogue between the maintainer and the AI assistant may remain in Japanese.
