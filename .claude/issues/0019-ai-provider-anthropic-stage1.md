# 0019 — AI provider interface (Phase 6 Slice 1, Anthropic Stage 1)

- **Status:** closed (landed on `develop` 2026-06-25)
- **Phase:** web-side Phase 6 Slice 1 (desktop equivalent: ADR-0023 Stage 1)
- **Opened:** 2026-06-25
- **Closed:** 2026-06-25
- **Branch:** none (direct-to-`develop`, per the Phase 4/5 slice pattern)
- **Depends on:** [`0003`](./0003-nestjs-http-surface.md) (the NestJS DI container this slice wires into) and the cross-repo no-op brief at [`../handoff/2026-06-24-ai-phase6-no-contract-mirror-incoming.md`](../handoff/2026-06-24-ai-phase6-no-contract-mirror-incoming.md) that explicitly unblocks this work without an HTTP-contract mirror.
- **Blocks:** future Slice 2 (`POST /ai/explain` / `POST /ai/suggest` web-only HTTP route) and Slice 3 (Nuxt `useAiAssist()` + `AiPanel.vue` + 11-locale i18n).
- **Anchors:**
  - Desktop ADR-0023 in `dbboard/docs/decisions.md` (search `## ADR-0023`); Decision 3 ("In-process wiring, not HTTP-mediated") and Decision 9 (Stage 2 deferrals) in particular.
  - Reference implementation: `crates/dbboard-ai` (desktop PR #20, `dbboard@584348f`); `crates/dbboard-anthropic` (desktop PR #22, `dbboard@c705918`); env-var wiring (desktop PR #24, `dbboard@6ad670d`).
  - Web ADR entry "2026-06-24 — AI Phase 6: no HTTP contract mirror needed (desktop ADR-0023 Stage 1)" in [`../decisions.md`](../decisions.md).
  - Web roadmap entry: [`../roadmap.md`](../roadmap.md) § "Phase 6 — Optional AI provider interface".

## Goal

Stand up the **AI provider interface and one Anthropic adapter** behind an env-var gate so the Phase 6 DoD bullets are satisfied at the API layer:

- `apps/api/src/domain/ai/` defines a provider port (interface).
- At least one adapter (Anthropic) implemented behind an environment flag.
- Core flows work with the AI module disabled.

No HTTP route, no Nuxt UI, no i18n keys — those belong to follow-up slices. This slice only ships the **module skeleton** so a future controller / use case can `@Inject(AI_PROVIDER)` and degrade gracefully when no key is configured.

## What this is — and what it isn't

**Is:**

- A new `apps/api/src/domain/ai/ai-provider.port.ts` defining `AiProvider` (interface), `AiCapabilities` (flat-bool, all-false default mirroring desktop's `AiCapabilities`), `ExplainRequest`, `SuggestRequest`, `AiResponse`, and the `AI_PROVIDER` DI symbol token. TypeScript-flavored equivalent of desktop's Rust trait shape.
- A new `apps/api/src/domain/ai/ai-error.ts` — `AiError extends Error`. Stage 1 keeps a single domain error class; subclassing into auth / rate-limit / network categories is deferred until a consumer needs to discriminate. Deliberately does **not** extend `CategorizedError` — the wire-contract envelope has no AI category (ADR redline).
- A new `apps/api/src/infrastructure/anthropic-provider.ts` implementing `AiProvider` over `@anthropic-ai/sdk`. The adapter depends on a narrow `AnthropicClient` interface (mirroring the `PgQueryRunner` pattern in `postgres-adapter.ts`) so unit tests stub the SDK without a network round-trip; the real `Anthropic#messages` object satisfies the interface structurally.
- A small extension of `apps/api/src/bootstrap/config.ts` — adds two named exports:
  - `ANTHROPIC_API_KEY: string | undefined` (`process.env.DBBOARD_ANTHROPIC_API_KEY`, empty-string normalised to `undefined`).
  - `ANTHROPIC_MODEL: string` (`process.env.DBBOARD_ANTHROPIC_MODEL`, default `"claude-sonnet-4-6"`).
- An `app.module.ts` wiring entry — `{ provide: AI_PROVIDER, useFactory: () => ANTHROPIC_API_KEY ? new AnthropicProvider(...) : undefined }`. When the env var is absent the factory returns `undefined` so AppModule still boots; future consumers mark the injection `@Optional()`.
- A `.env.example` update — adds `DBBOARD_ANTHROPIC_API_KEY=` and `DBBOARD_ANTHROPIC_MODEL=`. Removes the placeholder `AI_PROVIDER=openai` / `OPENAI_API_KEY=` lines (those were a Phase 6 scaffold; Anthropic is the actual first provider per the desktop brief and maintainer preference).
- A `docs/deployment.md` "Optional: Anthropic AI provider" section documenting the env vars, the symmetry with desktop's `DBBOARD_ANTHROPIC_*` names, and the "absence = AI disabled" behaviour.

**Isn't:**

- An HTTP route. ADR-0023 Decision 3 keeps AI off the contract; web Slice 2 may add `/ai/*` as a web-only route later, but Slice 1 ships nothing under `presentation/`.
- A Nuxt composable / panel / i18n keys. Those land in Slice 3.
- Streaming or function-calling. Desktop's Stage 1 `AiCapabilities` flat-bools default false; web mirrors the posture even though the SDK supports both — the UI side isn't wired for them yet.
- Persisted-key storage (settings UI, OS keychain, `ai-providers.toml`). Stage 2 territory per ADR-0023 Decision 9.
- Recording AI calls in `history.jsonl`. **Hard redline** — would force a `v: 1 → v: 2` schema bump and break the `0018` round-trip cross-check. AI responses must not flow through `HistoryRecordingInterceptor` or `HistoryStore`.
- An OpenAI adapter. Roadmap reads "OpenAI or Claude"; the maintainer picked Anthropic for symmetry with desktop's `dbboard-anthropic`.
- A change to `docs/api-contract.md`. The wire contract stays silent on AI.

## Scope

1. **`apps/api/package.json`** _(modified)_ — `pnpm --filter @dbboard-web/api add @anthropic-ai/sdk`. Pin whatever `pnpm add` resolves (`minimumReleaseAge: 1440` keeps fresh releases out automatically).
2. **`apps/api/src/domain/ai/ai-provider.port.ts`** _(new)_ — the port + value types + `AI_PROVIDER` symbol. Pure types and the symbol; no runtime imports from `infrastructure/` or `presentation/`.
3. **`apps/api/src/domain/ai/ai-error.ts`** _(new)_ — `AiError` base class. `name` set via `new.target.name`; preserves `cause` for upstream SDK errors.
4. **`apps/api/src/infrastructure/anthropic-provider.ts`** _(new)_ — `AnthropicProvider` class + `AnthropicClient` narrow interface + small prompt builders. Constructor: `(client: AnthropicClient, model: string)`. `getId()` → `"anthropic"`; `getCapabilities()` → all-false flat-bool. `explain` / `suggestSql` build a single Messages request, extract `content[0].text`, wrap upstream throws in `AiError`.
5. **`apps/api/src/bootstrap/config.ts`** _(extended)_ — add `ANTHROPIC_API_KEY` (empty-string normalised to `undefined`) and `ANTHROPIC_MODEL` (default `"claude-sonnet-4-6"`). Keep `MAX_BODY_BYTES` / `BIND_HOST` / `API_SECRET` / `assertSafeBindConfig` untouched.
6. **`apps/api/src/app.module.ts`** _(extended)_ — `{ provide: AI_PROVIDER, useFactory: () => ANTHROPIC_API_KEY ? new AnthropicProvider(new Anthropic({ apiKey: ANTHROPIC_API_KEY }), ANTHROPIC_MODEL) : undefined }`. Inject nothing. No consumer in Slice 1.
7. **`.env.example`** _(modified)_ — replace the placeholder `AI_PROVIDER=openai` / `OPENAI_API_KEY=` lines with the Anthropic ones.
8. **`docs/deployment.md`** _(modified)_ — append a short "Optional: Anthropic AI provider" section after the existing "Connecting to Aurora DSQL" section.
9. **Tests:**
   - `apps/api/src/bootstrap/config.spec.ts` _(extended)_ — `ANTHROPIC_API_KEY` defaults to undefined / normalises empty / honours non-empty; `ANTHROPIC_MODEL` defaults to `"claude-sonnet-4-6"` / honours override.
   - `apps/api/src/infrastructure/anthropic-provider.spec.ts` _(new)_ — `getId()` / `getCapabilities()` shapes; `explain()` and `suggestSql()` produce a Messages request with the configured model and return the text + model from the response; upstream SDK throws are wrapped in `AiError` with `cause` preserved; empty content array → `AiError`.
   - `apps/api/test/ai-provider.integration.spec.ts` _(new)_ — bootstraps `AppModule` twice via `Test.createTestingModule({ imports: [AppModule] })`: once with `DBBOARD_ANTHROPIC_API_KEY` unset (asserts module compiles, `AI_PROVIDER` resolves to undefined), once with it set (asserts module compiles, `AI_PROVIDER` resolves to an `AnthropicProvider` instance). Both runs assert `/health` and `/connections` controllers are still wired (core flows unaffected by AI module presence).

## Definition of Done

- [x] `pnpm --filter @dbboard-web/api add @anthropic-ai/sdk` recorded in `apps/api/package.json` and `pnpm-lock.yaml`. No other deps touched.
- [x] `AiProvider` port + `AiCapabilities` + `ExplainRequest` / `SuggestRequest` / `AiResponse` types + `AI_PROVIDER` symbol live in `apps/api/src/domain/ai/`.
- [x] `AnthropicProvider` implements the port and depends on a narrow `AnthropicClient` interface (mockable).
- [x] `apps/api/src/bootstrap/config.ts` exports `ANTHROPIC_API_KEY` and `ANTHROPIC_MODEL` with the env-var semantics above.
- [x] `app.module.ts` registers `AI_PROVIDER` via `useFactory`; the factory returns `undefined` when no key is set.
- [x] Integration spec confirms `AppModule` boots both with and without `DBBOARD_ANTHROPIC_API_KEY`; `/health` + `/connections` controllers resolve in both cases.
- [x] `.env.example` and `docs/deployment.md` document the env vars.
- [x] No HTTP route under `/ai/*` lands in this slice.
- [x] No AI record flows through `HistoryRecordingInterceptor` or `HistoryStore`.
- [x] `docs/api-contract.md` is unchanged.
- [x] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.

## Verification commands

```sh
pnpm --filter @dbboard-web/api test
pnpm format:check
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build
```

Sanity check the contract is untouched:

```sh
git diff --stat develop -- docs/api-contract.md   # expect: no output
```

Sanity check the history schema is untouched:

```sh
git diff --stat develop -- apps/api/src/domain/history-record.ts   # expect: no output
git diff --stat develop -- apps/api/src/presentation/interceptors/   # expect: no output
```

## Work log

- 2026-06-25 — landed on `develop` in TDD order:
  1. `pnpm --filter @dbboard-web/api add @anthropic-ai/sdk` — pnpm's `minimumReleaseAge: 1440` correctly held back the just-published `0.106.0` and pinned `^0.105.0` instead (the quarantine is doing what it should). Lockfile updated; no other deps touched.
  2. Drafted `apps/api/src/domain/ai/ai-provider.port.ts` (`AiProvider` / `AiCapabilities` / `ExplainRequest` / `SuggestRequest` / `AiResponse` / `AI_PROVIDER`) and `apps/api/src/domain/ai/ai-error.ts` (`AiError`).
  3. Wrote 8 failing `apps/api/src/infrastructure/anthropic-provider.spec.ts` cases against the not-yet-existing `AnthropicProvider`; confirmed red.
  4. Implemented `apps/api/src/infrastructure/anthropic-provider.ts` with a narrow `AnthropicClient` interface (mirrors `PgQueryRunner` in `postgres-adapter.ts`), single-turn `messages.create` call, `extractText()` over the content blocks, upstream throws wrapped in `AiError` with `cause` preserved. All 8 specs green.
  5. Extended `apps/api/src/bootstrap/config.spec.ts` with 6 red specs covering `ANTHROPIC_API_KEY` (undefined / empty-string normalised / non-empty) and `ANTHROPIC_MODEL` (default `"claude-sonnet-4-6"` / empty-fallback / override); extended `config.ts` to satisfy them; all green.
  6. Wrote 3 red specs at `apps/api/test/ai-provider.integration.spec.ts` (no-key boot, key-configured boot, provider-metadata sanity); wired `AI_PROVIDER` into `app.module.ts` via `useFactory` returning `undefined` when no key, otherwise wrapping `new Anthropic({apiKey})` in `AnthropicProvider`; structural seam adapted with `as unknown as AnthropicClient` at the wiring layer (commented inline — SDK overload set is wider than our non-streaming slice). All green.
  7. Updated `.env.example` (replaced placeholder OpenAI lines with `DBBOARD_ANTHROPIC_*` ones), added `docs/deployment.md` § "Optional: Anthropic AI provider", updated `.claude/roadmap.md` Phase 6 block + `.claude/project-status.md` with the slice-1 closeout entry.
  8. Verification chain green (see ticket § "Verification commands"); `git diff --stat develop` confirms `docs/api-contract.md`, `apps/api/src/domain/history-record.ts`, and `apps/api/src/presentation/interceptors/` are untouched. Closed and committed per-phase.
