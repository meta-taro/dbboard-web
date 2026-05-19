# Roadmap

Phases for **dbboard-web** with explicit Definition of Done (DoD). Phases are completed sequentially unless explicitly noted as parallelizable.

## Phase 0 — Bootstrap & rules

Establish the working agreement and AI-agent context before any code lands.

**DoD**
- [x] `CLAUDE.md`, `AI_AGENT_RULES.md`, `DESIGN.md`, `README.md` present.
- [x] `.claude/{project-status,roadmap,decisions}.md` present.
- [x] `.gitignore` in place.
- [x] Maintainer review complete (2026-05-19, cross-repo audit with `dbboard`).

## Phase 1 — Monorepo scaffold

Initialize the pnpm workspace and empty Nuxt + NestJS apps.

> **Scheduled after `dbboard` Phase 1.** See [decisions.md — Initial sequencing](./decisions.md). Wait until the desktop Turso vertical slice is working and a draft API contract exists, then start this phase against that contract.

**DoD**
- `pnpm install` succeeds from a clean clone.
- `pnpm -r build` succeeds (Nuxt + NestJS).
- `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test` succeed (empty test suites allowed).
- Husky pre-commit and pre-push hooks installed and runnable.
- `corepack` pins the pnpm version via the `packageManager` field.

## Phase 2 — Database connection management API

Backend module for registering and listing database connections.

**DoD**
- NestJS module `database/` exposes `POST /connections`, `GET /connections`, `DELETE /connections/:id`.
- Connections persisted (initial target: in-memory + file fallback).
- Unit tests for domain and use case layers, integration test for the HTTP surface.
- Secrets never logged or returned in responses.

## Phase 3 — SQL execution endpoint

Backend module for executing queries against a registered connection.

**DoD**
- `POST /connections/:id/query` returns rows + metadata or a structured error.
- Per-connection timeout and row-limit enforcement.
- Integration test against at least one real provider (Neon branch or local libSQL).

## Phase 4 — Frontend: connection & query UI

Nuxt UI for managing connections and executing queries.

**DoD**
- Connection list, add and remove flow.
- SQL editor (Monaco or CodeMirror) with run shortcut.
- Result grid with virtualized rendering.
- E2E smoke test via Playwright.

## Phase 5 — Schema browser & query history

Side panels for browsing tables / schemas and replaying past queries.

**DoD**
- Tree view of schemas → tables → columns for PostgreSQL and libSQL.
- Local history with timestamp and connection scope.

## Phase 6 — Optional AI provider interface

Pluggable interface for AI-assisted SQL generation and explanation.

**DoD**
- `backend/src/modules/ai/` defines a provider port (interface).
- At least one adapter (OpenAI or Claude) implemented behind an environment flag.
- Core flows work with the AI module disabled.

## Later

- Authentication.
- Multi-user support.
- Plugin system.
- Real-time collaboration.
- Advanced query analysis.

## Relationship with the desktop client

The desktop client `dbboard` is an **independent native Rust application** with its own local Rust API. It does not share code, processes, or runtime calls with `dbboard-web`. The only alignment is at the **API-contract** level (connection shape, query envelope, error codes, AI shapes) and on **user-data interop** (export and import JSON formats). Implementation duplication between the two stacks is permanent and acceptable. See [decisions.md](./decisions.md) for the full policy.
