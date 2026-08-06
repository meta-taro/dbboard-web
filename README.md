# dbboard-web

**A self-hosted web client for your databases — runs in any browser on your network, installs to your phone as a PWA.**

> **"Isn't the [desktop client](https://github.com/meta-taro/dbboard) enough?"**
>
> For working at your laptop, yes — that is what the desktop app is for. `dbboard-web` exists for the moments the desktop app cannot reach:
>
> - Glancing at production signup counts from your phone during a meeting.
> - Verifying that a specific user's order actually went through, from the kitchen.
> - Killing a long-running query while you are away from your desk.
> - Letting a teammate hit the same database from their browser without installing anything.
>
> You run `dbboard-web` once on a laptop, a VPS, or a homelab box. After that, any device on your network reaches it through a browser — and on a phone you can install it to the home screen as a PWA for ambient, read-mostly access. No app store, no mobile build, no separate codebase.

`dbboard-web` is the browser-based counterpart of the [`dbboard`](https://github.com/meta-taro/dbboard) desktop client. It provides a unified interface for managing and querying serverless PostgreSQL and libSQL databases, with optional AI assistance for query authoring and explanation.

The desktop client and `dbboard-web` are **independent applications** that share an HTTP API contract by convention. See [`docs/api-contract.md`](./docs/api-contract.md) and [.claude/decisions.md](./.claude/decisions.md).

## Status

Phase 1.5 — PWA shell merged on `develop` (PR [#4](https://github.com/meta-taro/dbboard-web/pull/4)). The Nuxt app is installable as a Progressive Web App with manifest, auto-updating service worker, `/offline` fallback, iOS Safari head meta, an opt-in install prompt, and a mobile-first responsive baseline. Code-side DoD is green; the four real-device acceptance items (Android Chrome "Add to Home Screen", iOS Safari standalone, Lighthouse PWA ≥ 90, offline cold start) are still pending the maintainer. The HTTP contract is mirrored at v2 (Phase 2 surface from desktop). Phase 2.5 — Multilingual UI Stage 1 (11 locales: English, Japanese, Korean, Simplified + Traditional Chinese, German, French, Spanish, Brazilian Portuguese, Russian, Italian) is in progress on `feature/phase-2.5-i18n`, mirroring the desktop sibling's ADR-0015 that shipped on the same day. Phase 2 backend implementation (`0003` HTTP surface, `0004` Postgres adapter, `0005` conformance) runs in parallel with Phase 2.5 — different files, no overlap. See [.claude/project-status.md](./.claude/project-status.md) and [.claude/roadmap.md](./.claude/roadmap.md) for the live status.

## Stack

- **Frontend:** Nuxt 4 (Vue 3, TypeScript)
- **Backend:** NestJS 11 (Node.js, TypeScript)
- **Databases:** Neon, Supabase, Turso / libSQL, Cloudflare D1
- **Package manager:** pnpm via corepack (required — see [AI_AGENT_RULES.md](./AI_AGENT_RULES.md#2-package-manager))

## Architecture

```
User → Nuxt UI → NestJS API → Database
```

All database access flows through the backend API. AI integration is an optional module and must not be tightly coupled to database logic. The NestJS API conforms to the HTTP contract documented in [`docs/api-contract.md`](./docs/api-contract.md).

## How to get it

`dbboard-web` is **self-hosted OSS**. There is no maintainer-operated SaaS, no hosted demo, and no managed offering. You run your own instance. See [.claude/decisions.md](./.claude/decisions.md) for the rationale.

Three supported install paths, in order of how much you want to touch:

1. **Docker Compose (recommended).** Pull the pre-built images and bring up the stack.

   ```sh
   curl -L -o docker-compose.yml https://raw.githubusercontent.com/meta-taro/dbboard-web/main/deploy/docker-compose.yml
   docker compose up -d
   # Open http://localhost:3000
   ```

   Images are published to `ghcr.io/meta-taro/dbboard-web-api` and `ghcr.io/meta-taro/dbboard-web-web`. The `deploy/docker-compose.yml` file lands with the Docker phase of the roadmap.

2. **From source.**

   ```sh
   corepack enable
   pnpm install
   pnpm -r build
   pnpm -r start
   # API on http://localhost:4000, web on http://localhost:3000
   ```

3. **One-click templates.** Community-maintained deploy templates for Fly.io / Railway / Vercel + Render etc. may live under `deploy/` or a sibling repo. These are not the primary supported path.

### Choosing between dbboard and dbboard-web

|              | `dbboard` (desktop)     | `dbboard-web`                                             |
| ------------ | ----------------------- | --------------------------------------------------------- |
| Install      | Native binary           | Docker Compose / from source                              |
| Runs on      | Your laptop             | Laptop / VPS / homelab                                    |
| Access from  | The host machine        | Any browser on your network                               |
| Mobile       | Not supported           | Install as a PWA — Android Chrome + iOS Safari 16.4+      |
| Mobile usage | —                       | Ambient, read-mostly (glance, verify, kill stuck query)   |
| Users        | Single                  | Single now, team in a later phase                         |
| Best for     | Fastest local-only path | Multi-device + phone access on your own self-hosted infra |
| Auth         | None (local-only)       | None by default, optional OIDC later                      |

The two are siblings, not a tiered product. Pick whichever fits how you work.

## Development

```sh
corepack enable
pnpm install
pnpm dev           # starts both apps via the root script
pnpm -r build
pnpm -r typecheck
pnpm -r lint
pnpm -r test
```

Environment variables are documented in `.env.example` (lands with the first adapter implementation).

## Project layout

```
apps/
  web/             # Nuxt app (frontend)
  api/             # NestJS app (backend)
docs/              # API contract and design references
  api-contract.md  # Canonical HTTP API contract (mirrored from dbboard)
.claude/           # AI agent working files (status, roadmap, decisions, issues)
deploy/            # Docker Compose stack and deploy templates (added in a later phase)
```

## Contributing

Read [CLAUDE.md](./CLAUDE.md) and [AI_AGENT_RULES.md](./AI_AGENT_RULES.md) first. The same rules apply to human and AI contributors. In short:

- TDD: failing test first, then minimal implementation.
- pnpm only — never `npm` or `yarn`.
- Keep business logic out of controllers; layered architecture is enforced.
- AI authors commits; humans push and open PRs.
- All repository files are in English.

## Purpose

`dbboard-web` is intentionally **not a production SaaS**. It is:

- A learning platform for full-stack development.
- A reference for multi-database client architecture.
- A base for AI-assisted developer tooling.
- A self-hostable companion to the native desktop client.

Clarity and extensibility are prioritized over feature completeness.

## License

See [LICENSE](./LICENSE).
