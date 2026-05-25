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

## 2026-05-19 — Relationship with `dbboard` desktop client

**Context.** `dbboard-web` and the desktop client `dbboard` (https://github.com/meta-taro/dbboard) are developed by the same maintainer. The desktop client is a **native Rust GUI** application with its own **local Rust API layer**. The two clients do **not** communicate with each other at runtime — they are independent applications that happen to expose the same conceptual API surface to their own UI layer.

**Decision.**

- The two repositories are **fully independent applications**, not two faces of one product:
  - `dbboard-web`: Nuxt UI + NestJS API + databases (this repo).
  - `dbboard`: native Rust GUI + local Rust API + databases.
- **No runtime coupling.** Neither client calls the other's API; neither shares process, build, or release pipelines. A user can install either or both without dependencies between them.
- **What is shared:** the **API contract** only — connection definition shape, query request and response envelopes, error category codes, schema metadata shape, and AI provider request and response shapes. The contract is described in human-readable form so each repository can translate it into idiomatic types for its language (TypeScript DTOs here, `serde` structs there).
- **What is NOT shared:** controllers, services, DB drivers, UI components, build tooling, dependency lockfiles, or any source code.
- **User-data interop.** Export and import formats for connections and query history use the same JSON shape on both sides, so a user can move state between desktop and web. This is the only artifact the two clients exchange.
- **Pace policy.** Maintainer attention is split between the two repos. Phases on each side are sized to be completable in a single focused session, and changes never leave either repo in a broken state. Either side may move ahead on any phase without waiting for the other.
- **Contract evolution.** When the shared API surface changes, the side that needs the change updates the contract first (in human-readable docs), then both sides adopt it on their own schedule. Implementation duplication is permanent and acceptable — the two stacks are too different to share code.

**Rationale.** A native Rust GUI cannot meaningfully reuse a NestJS server or TypeScript UI components, so attempting to share implementation would be pure cost. Keeping the contract aligned by convention captures the only real coupling (consistent vocabulary and exportable user data) without forcing either codebase to compromise on language idioms or tooling.

**Cross-references.** This decision is mirrored on the desktop side as `dbboard/docs/decisions.md` ADR-0004 (revised) and ADR-0006 (local axum HTTP backend, loopback, auto-port).

---

## 2026-05-19 — Initial sequencing: `dbboard` Phase 1 runs before `dbboard-web` Phase 1

**Context.** Both repos are at Phase 0. Either side may proceed independently per the coordination policy above, but the maintainer's attention is split. We need an explicit "what to do this week" without rewriting the coordination policy.

**Decision.**

- `dbboard` (desktop) Phase 1 — Turso vertical slice — runs first.
- `dbboard-web` Phase 1 — monorepo scaffold — is staged behind it.
- Once the desktop slice is working end-to-end, the API contract is drafted (canonical form to be decided) and `dbboard-web` Phase 1 starts.

**Rationale.** `dbboard-web` Phase 1 is mostly scaffolding (pnpm workspace, empty Nuxt + NestJS apps). Doing it first would not move the actual problem forward, and any contract assumptions it bakes in would have to be revised once the desktop slice reveals real shapes. Letting the desktop slice ship first means the web scaffold can lock in a contract that already runs somewhere.

**Reversibility.** Cheap to reverse — neither repo has implementation code that depends on the sequence.

---

## 2026-05-25 — Adopt `dbboard` HTTP API contract as Phase 1 input

**Context.** The desktop client `dbboard` closed Phase 1 at workspace `0.1.0` and shipped a stable HTTP contract documented in `dbboard/docs/api-contract.md`. Per their `ADR-0011`, `dbboard@1.0.0` is gated on interop with `dbboard-web`, which puts the contract mirror on the critical path here. Per their `ADR-0004` (the relationship policy mirrored as the second decision in this log), contract evolution flows through the desktop side first, then mirrors here.

**Decision.**

- The contract at `dbboard@89b7c70:docs/api-contract.md` (last touched at `3f114e4`, "publish the 10,000-row per-query cap") is mirrored into this repo as [`docs/api-contract.md`](../docs/api-contract.md) and becomes the binding target for Phase 1 implementation.
- The mirror is content-identical (line endings normalized to LF to match repo convention).
- Desktop `ADR-0004`, `ADR-0006` (loopback HTTP backend), `ADR-0009` (canonical contract), and `ADR-0011` (SemVer + interop gate) are the canonical references — this repo does not re-derive them.
- Issue [`0001`](./issues/0001-web-contract-mirror.md) tracks the mirror itself and lists follow-up issues for implementation (`0002` scaffold, `0003` HTTP surface, `0004` Postgres adapter, `0005` row cap + conformance tests).

**Explicitly out of scope.** Desktop `ADR-0012` (capability model: `GET /capabilities`, `capability` error category, `/views/...` etc. prefixes) is **not yet implemented on the desktop**. It is purely additive to the current three endpoints, so a mirror built today is forward-compatible; the capability surface will be re-mirrored after the desktop ships it.

**Rationale.** Mirroring now is forward-compatible (capabilities are additive), it unblocks `dbboard@1.0.0`, and it gives the upcoming NestJS scaffold a fixed contract instead of a moving target. Holding off would have meant chasing the desktop's still-shifting contract through Phases 1.5 / 1.6 / 1.7; that phase is now over.

**How contract changes flow.** Per `ADR-0004`, the desktop side drafts the change in `dbboard/docs/api-contract.md` first. When that lands, this repo re-runs the mirror against the new snapshot. Web-side ambiguities discovered during implementation are filed as desktop-side ADR questions — never resolved unilaterally here.

**Reversibility.** The mirror is a documentation artifact. Reverting it costs only the documentation churn; no code has been written against it yet.

---

## 2026-05-25 — Branch policy: `feature/<slug>` → PR → `develop`

**Context.** The repo currently has only docs commits, all landed directly on `develop`. Phase 1 starts shipping real code, and the maintainer also runs the `dbboard` desktop repo, which already follows a `feature/<slug>` → PR → `develop` workflow per `dbboard@ADR-0005`. Aligning the two repos reduces context-switching cost.

**Decision.**

- `develop` is the default branch and the integration target for ongoing work.
- All changes from Phase 1 onward go through a `feature/<slug>` branch and a pull request into `develop`.
- The pull request is the review gate: even for solo work, it forces a final pass over the diff and a clean commit history.
- `main` is reserved for releases. The first `main`-bound merge happens when `0.1.0` is tagged (see "Versioning" — to be added when the first release is cut).
- Conventional Commits remain mandatory (`AI_AGENT_RULES.md` §6).
- Pre-merge: lint, typecheck, and tests must be green (`AI_AGENT_RULES.md` §5). CI will enforce this once it lands; until then the pre-push hook does.
- AI agents author commits on feature branches but **do not push or open PRs** — the human pushes the branch and opens the PR (`AI_AGENT_RULES.md` §6).
- Docs-only changes may still land directly on `develop` when they are part of closing out a previous handoff (e.g. the 2026-05-25 contract-mirror commits on `develop`). From Phase 1 implementation onward this exception ends.

**Rationale.** The desktop side codified the same policy in ADR-0005 for the same reasons: cleaner history, easier to bisect, makes future CI / contributor onboarding straightforward without a second policy migration. Solo PR overhead is small (a few seconds) and the discipline is worth it.

**Reversibility.** Cheap to reverse; the policy is procedural and changing it does not affect any committed artifact.

---

## 2026-05-25 — Distribution model: self-host OSS, no maintainer-run SaaS

**Context.** The desktop client (`dbboard`) and `dbboard-web` are both OSS by the same maintainer. The desktop already covers "single-user, local laptop, native install". `dbboard-web` needs its own clear reason to exist, and a distribution model that matches the maintainer's intent (CLAUDE.md: "Not a production SaaS").

**Decision.**

- **Self-host only.** Users run their own instance of `dbboard-web`. The maintainer does not operate a managed SaaS, hosted demo, or any user-facing endpoint of this code. This is stated in the README.
- **Primary distribution**: a Docker Compose stack (NestJS API + Nuxt web, optional reverse proxy) and pre-built images on the GitHub Container Registry under `ghcr.io/meta-taro/dbboard-web-*`. Users run `docker compose up` and the app is at `http://localhost:<port>`.
- **Secondary distribution**: from-source install via `pnpm install && pnpm build && pnpm start`, for contributors and homelab users who prefer no containers.
- **Optional convenience**: one-click deploy templates for Fly.io / Railway / Vercel + Render / etc., as community-maintained add-ons in `deploy/` or a separate repo. These are not the primary supported path.
- **Authentication**: no auth by default — appropriate for single-user behind a reverse proxy or trusted network. An optional auth layer (basic / OIDC) gated behind an environment flag is a later phase.
- **No telemetry, no phone-home.** The service is fully usable offline (modulo whatever the configured DB requires).
- **Differentiation from desktop:**
  - Desktop = local-only native install, single-user, fastest path, no server.
  - Web = browser UI + server, runs anywhere from laptop to homelab to VPS, accessible from multiple devices, prepares ground for future team / multi-user use.
- **Branding parity** with the desktop is intentional: same name, same JSON shapes (export/import), aligned HTTP contract. They are siblings, not a product line.

**Rationale.** Operating a SaaS is open-ended: it implies SLA, auth, billing, multi-tenancy, abuse handling, GDPR, paging. None of those align with "Not a production SaaS." Self-host keeps the project a tool, not a service. Pre-built Docker images make self-hosting a five-minute task — the friction is low enough that "I want a hosted version" rarely outweighs "I can run this myself."

**Authentication is deferred** because the primary deployment shape (single-user behind a reverse proxy) does not need it, and bolting it on later behind an env flag is straightforward. Shipping unauth defaults that match desktop semantics keeps the two clients conceptually identical.

**Reversibility.** Reversible. If demand for a hosted version surfaces, the same OSS code can be deployed as a managed service later; nothing here precludes that. The decision is about what the maintainer commits to operating, not what the code allows.
