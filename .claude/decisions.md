# Technical decisions

Append-only log of significant technical decisions. Each entry: date, decision, context, alternatives considered, rationale.

---

## 2026-05-19 — Frontend framework: Nuxt

**Context.** A browser-based counterpart to the `dbboard` desktop client is needed.

**Alternatives.** Next.js, SvelteKit, Remix.

**Decision.** Nuxt (Vue 3, TypeScript).

**Rationale.** Vue's reactivity model fits the live-query / live-result use case well, Nuxt provides a mature SSR + Nitro server story, and the ecosystem covers auto-imports, route handlers, and server middleware out of the box.

---

## 2026-05-19 — Backend framework: NestJS

**Context.** An API layer separating the frontend from databases.

**Alternatives.** Fastify (vanilla), Hono, Express, embedding the API into Nuxt's Nitro server.

**Decision.** NestJS.

**Rationale.** Module boundaries map cleanly to the layered architecture rule. Built-in dependency injection makes the AI provider plug-in pattern straightforward.

---

## 2026-05-19 — Package manager: pnpm

**Context.** Supply-chain and dependency-correctness concerns make `npm` undesirable for this project.

**Decision.** pnpm only; `npm` and `yarn` are forbidden.

**Rationale.** Strict dependency resolution avoids phantom imports, `onlyBuiltDependencies` allowlists install scripts, `minimumReleaseAge` quarantines freshly published versions, and the `packageManager` field plus `corepack` give reproducible installs.

---

## 2026-05-19 — Language for repository artifacts: English

**Context.** Open-source project intended for an external audience.

**Decision.** All files in the repository (markdown, code comments, commit messages, PR text) are written in English. Direct maintainer↔assistant dialogue may remain in Japanese.

**Rationale.** Maximizes contributor reach without making maintenance harder for the primary maintainer, who prefers Japanese for personal channels.

---

## 2026-05-19 — Coordination with `dbboard` desktop client

**Context.** `dbboard-web` and the desktop client `dbboard` (https://github.com/meta-taro/dbboard) are developed by the same maintainer in parallel. As of 2026-05-19 both repositories are at Phase 0 with only `LICENSE` committed, so there is no legacy on either side to preserve.

**Decision.**

- The two repositories evolve **independently** — neither is a monorepo subproject of the other, and neither blocks the other's releases.
- Domain vocabulary (connection definition shape, query result envelope, error categories, schema metadata) is kept **aligned by convention**. Divergences are documented in this file when they occur.
- **Pace policy.** Because the maintainer's attention is split between the two repos, phases on each side are sized to be completable in a single focused session. Avoid in-flight cross-repo work that would leave either side broken if the maintainer switches contexts.
- **Sequencing recommendation.** Prefer to land Phase 2 (connection management API) and Phase 3 (SQL execution) on `dbboard-web` first. The NestJS backend can later be reused by `dbboard` (e.g., via Tauri shelling out, or by sharing the domain TypeScript types), which reduces total work compared to building two independent backends.
- **Duplication is acceptable** in early phases. If the shared surface grows large enough to justify it, a separate `dbboard-shared` package will be extracted later.

**Rationale.** A premature shared package would slow both projects down while the design is still in flux. Convention-based alignment is cheaper at this stage and keeps each repo independently buildable and shippable. Both projects starting from zero on the same day means there is no migration cost to coordinating the domain shape from the outset.
