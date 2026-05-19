# dbboard-web

A modern multi-database web client with pluggable AI providers.

`dbboard-web` is the browser-based counterpart of the `dbboard` desktop client. It provides a unified interface for managing and querying serverless PostgreSQL and libSQL databases, with optional AI assistance for query authoring and explanation.

## Status

Early scaffolding — no application code yet. See [.claude/project-status.md](./.claude/project-status.md) and [.claude/roadmap.md](./.claude/roadmap.md).

## Stack

- **Frontend:** Nuxt (Vue 3, TypeScript)
- **Backend:** NestJS (Node.js, TypeScript)
- **Databases:** Neon, Supabase, Turso / libSQL
- **Package manager:** pnpm (required — see [AI_AGENT_RULES.md](./AI_AGENT_RULES.md#2-package-manager))

## Architecture

```
User → Nuxt UI → NestJS API → Database
```

All database access flows through the backend API. AI integration is an optional module and must not be tightly coupled to database logic.

## Getting started

> Detailed setup will be filled in once the monorepo skeleton lands (Phase 1 of the roadmap).

```sh
# Prerequisite: pnpm via corepack
corepack enable
pnpm install
pnpm dev
```

Environment variables are documented in `.env.example` (added during scaffolding).

## Project layout (planned)

```
frontend/        # Nuxt app
  pages/
  components/
  composables/
backend/         # NestJS app
  src/
    modules/
      database/
      query/
      ai/
docs/            # Design references and deeper documents
.claude/         # AI agent working files (status, roadmap, decisions, issues)
```

## Contributing

Read [CLAUDE.md](./CLAUDE.md) and [AI_AGENT_RULES.md](./AI_AGENT_RULES.md) first. The same rules apply to human and AI contributors.

## Purpose

`dbboard-web` is intentionally not a production SaaS. It is:

- A learning platform for full-stack development.
- A reference for multi-database client architecture.
- A base for AI-assisted developer tooling.

Clarity and extensibility are prioritized over feature completeness.

## License

See [LICENSE](./LICENSE).
