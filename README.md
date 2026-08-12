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

**`v0.1.0` — the first release.** See [CHANGELOG.md](./CHANGELOG.md) for what is in it and what is not. Two limitations decide whether it fits you: **from source is the only installation path that works today**, and an instance is **single-user** — one shared bearer secret, no login.

**Development happens on `develop`.** `main` holds released state, so clone and browse `develop` — every link in this file points there.

**Desktop-parity programme complete, rungs 0 through 9.** The maintainer asked for the browser client to be brought as close to the [`dbboard`](https://github.com/meta-taro/dbboard) desktop client's spec as it can get; every desktop ADR was classified as a shared surface, a portable feature or not portable, then ordered into rungs by what breaks if it stays undone. Rungs 0–8 are done: the history schema at v2, the result grid (sort, export, cell viewer), editing, dump and restore, schema depth, the identifier dialect seam, the adapters — Postgres, MySQL/MariaDB, Turso/libSQL, Cloudflare D1, with an SSH bastion for the two that have a socket — and the AI assistant. Rung 9 mirrored the `$json` cell value desktop added for document stores. The UI is multilingual in 11 locales and installable as a PWA; the four real-device PWA acceptance items are still pending the maintainer. `docs/api-contract.md` is a byte-mirror of the cross-repo shared subset. See [.claude/parity-ledger.md](./.claude/parity-ledger.md) for the ADR-by-ADR survey and [.claude/project-status.md](./.claude/project-status.md) for the live status.

## Stack

- **Frontend:** Nuxt 4 (Vue 3, TypeScript)
- **Backend:** NestJS 11 (Node.js, TypeScript)
- **Databases:** Neon, Supabase, Turso / libSQL, Cloudflare D1, MySQL / MariaDB
- **Package manager:** pnpm via corepack (required — see [AI_AGENT_RULES.md](./AI_AGENT_RULES.md#2-package-manager))

## Architecture

```
User → Nuxt UI → NestJS API → Database
```

All database access flows through the backend API. AI integration is an optional module and must not be tightly coupled to database logic. The NestJS API conforms to the HTTP contract documented in [`docs/api-contract.md`](./docs/api-contract.md).

## How to get it

`dbboard-web` is **self-hosted OSS**. There is no maintainer-operated SaaS, no hosted demo, and no managed offering. You run your own instance. See [.claude/decisions.md](./.claude/decisions.md) for the rationale.

**From source is the only path that works today.** The other two are described so you can see where this is going, not so you can run them.

1. **From source.** Requires Node 22+ and [pnpm](https://pnpm.io) via corepack
   (`engines` in `package.json` is the authority).

   ```sh
   git clone -b develop https://github.com/meta-taro/dbboard-web.git
   cd dbboard-web
   corepack enable
   pnpm install
   pnpm -r build
   pnpm -r start
   # API on http://localhost:4000, web on http://localhost:3000
   ```

2. **Docker Compose (planned).** `deploy/docker-compose.yml` and the published images at `ghcr.io/meta-taro/dbboard-web-api` / `ghcr.io/meta-taro/dbboard-web-web` land with the Docker phase of the roadmap. There is deliberately no command here yet: a copy-paste that 404s costs more than an absent one.

3. **One-click templates (planned).** Community-maintained deploy templates for Fly.io / Railway / Vercel + Render etc. may live under `deploy/` or a sibling repo. These are not the primary supported path.

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
