# 0020 — AI explain + suggest HTTP routes (Phase 6 Slice 2)

- **Status:** open
- **Phase:** web-side Phase 6 Slice 2 (web-only — desktop ADR-0023 keeps AI in-process; no cross-repo wire to align with)
- **Opened:** 2026-06-25
- **Branch:** none (direct-to-`develop`, per the Phase 4/5/6-slice-1 pattern)
- **Depends on:** [`0019`](./0019-ai-provider-anthropic-stage1.md) (the `AiProvider` port + `AnthropicProvider` adapter + `AI_PROVIDER` symbol token + env-var gate this slice consumes).
- **Blocks:** Slice 3 (Nuxt `useAiAssist()` composable + `AiPanel.vue` + 11-locale i18n) — Slice 3 needs a wire shape to call against.
- **Anchors:**
  - Web Phase 6 roadmap block: [`../roadmap.md`](../roadmap.md) § "Phase 6 — Optional AI provider interface".
  - Web ADR entry "2026-06-24 — AI Phase 6: no HTTP contract mirror needed (desktop ADR-0023 Stage 1)" in [`../decisions.md`](../decisions.md) — establishes that `/ai/*` is web-only and the shared `docs/api-contract.md` is not updated.
  - Slice 1 closeout commit `027dd08` (`feat(api): wire optional Anthropic AI provider behind env-var gate`).

## Goal

Expose the Slice 1 AI provider through two HTTP routes so the Nuxt UI (Slice 3) has a wire to call against. Stay strictly web-only — `docs/api-contract.md` is the cross-repo shared subset and is not touched by this slice.

- `POST /ai/explain` — explain a SQL statement.
- `POST /ai/suggest` — turn a natural-language prompt into SQL.

Both routes degrade gracefully when `DBBOARD_ANTHROPIC_API_KEY` is unset (404 with a dedicated category so the UI can hide the AI panel instead of treating the absence as an error). Both routes are gated by the existing bearer-auth middleware from `0016` (no per-route auth opt-out). Neither route is recorded in `history.jsonl` (hard redline from the Slice 1 ADR — would force a v:1 → v:2 schema bump and break the `0018` round-trip cross-check).

## What this is — and what it isn't

**Is:**

- A new `apps/api/src/presentation/ai.controller.ts` exposing `POST /ai/explain` and `POST /ai/suggest`. Both return `200 OK` on success with `{ text: string, model: string }` (matches `AiResponse` from Slice 1).
- Two new use cases under `apps/api/src/usecase/` — `ExplainSql` and `SuggestSql`. Each `@Inject(AI_PROVIDER)` with `@Optional()`; throws `AiDisabledError` when the provider is undefined; wraps the adapter's `AiError` in `AiUpstreamError` so the wire mapping is deterministic.
- Two new DTOs under `apps/api/src/presentation/dto/` — `AiExplainRequestDto` (required `sql: string`, optional `dialect: string`) and `AiSuggestRequestDto` (required `prompt: string`, optional `dialect: string`). Validated via the existing global `ValidationPipe` (`whitelist: true`, 422 on missing/wrong fields).
- Two new categorised errors under `apps/api/src/domain/ai/`:
  - `AiDisabledError extends CategorizedError` — category `"ai_disabled"`, HTTP 404 via `ContractErrorFilter`. Mirrors the `capability` precedent: the route exists in code, but is gated off at this deployment, so the UI should hide the feature rather than surface it as a query error.
  - `AiUpstreamError extends CategorizedError` — category `"ai_provider"`, HTTP 502 via `ContractErrorFilter`. Mirrors the `connection` precedent: an upstream third-party service (Anthropic) failed.
- An extension of `apps/api/src/domain/errors/categorized-error.ts` — adds `"ai_disabled" | "ai_provider"` to the `ErrorCategory` union.
- An extension of `apps/api/src/presentation/filters/contract-error.filter.ts` — adds the two new categories to `CATEGORY_STATUS` (404 and 502 respectively).
- An extension of `apps/api/src/app.module.ts` — registers `ExplainSql` + `SuggestSql` use cases via `useFactory` with `@Optional()` provider, and adds `AiController` to the controllers list.
- A small extension of `docs/deployment.md` — adds two bullet points under the existing "Optional: Anthropic AI provider" section pointing at the new routes and the 404 / 502 behaviour.

**Isn't:**

- An update to `docs/api-contract.md`. That file is the cross-repo shared surface (matches the desktop `crates/dbboard-server` axum routes); `/ai/*` is web-only per ADR-0023, so it is not documented there. Same pattern as the existing `/connections/*` web-only routes.
- A change to `AiProvider`, `AnthropicProvider`, or `AiError`. The Slice 1 port stays untouched; this slice composes on top of it.
- A new wire shape that breaks Slice 1's `AiResponse`. The route returns `AiResponse` verbatim.
- A change to `HistoryRecordingInterceptor` or `historyRecordSchema`. `AiController` is **not** decorated with `@UseInterceptors(HistoryRecordingInterceptor)` and an integration spec asserts an AI call leaves `/history/export.jsonl` empty.
- A streaming or function-calling surface. Stage 1 capabilities stay flat-false; Slice 2 ships only the request/response shape Slice 1 exposed.
- A Nuxt composable, panel, or i18n keys. Those are Slice 3.
- A bearer-auth opt-out for `/ai/*`. The middleware from `0016` gates everything except `GET /health` and AI is no exception.
- A `GET /ai/capabilities` discovery route. Capabilities are part of the `AiProvider` port but not surfaced over HTTP in Slice 2 — Slice 3 can probe via a successful 200 vs. a 404 `ai_disabled` envelope.

## Scope

1. **`apps/api/src/domain/errors/categorized-error.ts`** _(modified)_ — extend the `ErrorCategory` union with `"ai_disabled" | "ai_provider"`. Add a comment noting these are web-only (not in `docs/api-contract.md`).
2. **`apps/api/src/domain/ai/ai-error.ts`** _(modified)_ — keep the existing `AiError` (adapter-internal); add `AiDisabledError extends CategorizedError` (category `"ai_disabled"`) and `AiUpstreamError extends CategorizedError` (category `"ai_provider"`), each preserving `cause`.
3. **`apps/api/src/presentation/filters/contract-error.filter.ts`** _(modified)_ — extend `CATEGORY_STATUS` with `ai_disabled: 404, ai_provider: 502`.
4. **`apps/api/src/usecase/explain-sql.use-case.ts`** _(new)_ — `ExplainSql` class. Constructor `(provider: AiProvider | undefined)`. `execute(request: ExplainRequest): Promise<AiResponse>` throws `AiDisabledError` when provider is undefined; otherwise calls `provider.explain(request)` and wraps a thrown `AiError` in `AiUpstreamError` (preserves `cause`).
5. **`apps/api/src/usecase/suggest-sql.use-case.ts`** _(new)_ — mirror of `ExplainSql` for `suggestSql`.
6. **`apps/api/src/presentation/dto/ai-explain-request.dto.ts`** _(new)_ — `sql: string` (`@IsString`, `@IsNotEmpty`), `dialect?: string` (`@IsOptional`, `@IsString`).
7. **`apps/api/src/presentation/dto/ai-suggest-request.dto.ts`** _(new)_ — `prompt: string` (`@IsString`, `@IsNotEmpty`), `dialect?: string` (`@IsOptional`, `@IsString`).
8. **`apps/api/src/presentation/ai.controller.ts`** _(new)_ — `@Controller("ai")` with `@Post("explain")` and `@Post("suggest")`, both `@HttpCode(200)`, no `@UseInterceptors`. Delegates to the two use cases. Returns `Promise<AiResponse>`.
9. **`apps/api/src/app.module.ts`** _(modified)_ — register `ExplainSql` and `SuggestSql` via `useFactory` with `@Optional() @Inject(AI_PROVIDER)`; add `AiController` to the controllers array.
10. **Tests:**
    - `apps/api/src/usecase/explain-sql.use-case.spec.ts` _(new)_ — 4 cases: throws `AiDisabledError` when provider undefined; delegates to `provider.explain` with the request; returns the provider's response verbatim; wraps `AiError` in `AiUpstreamError` with cause preserved.
    - `apps/api/src/usecase/suggest-sql.use-case.spec.ts` _(new)_ — mirror of `ExplainSql` (4 cases).
    - `apps/api/src/presentation/dto/ai-explain-request.dto.spec.ts` _(new)_ — accepts valid body, rejects missing `sql` / non-string `sql`, accepts missing `dialect`, strips unknown fields.
    - `apps/api/src/presentation/dto/ai-suggest-request.dto.spec.ts` _(new)_ — mirror for `prompt`.
    - `apps/api/test/ai-routes.integration.spec.ts` _(new)_ — bootstraps `AppModule` with a stub `AI_PROVIDER` via `overrideProvider` (no real `new Anthropic()`). Asserts: 200 + `{text, model}` happy path; 404 + `{error:{category:"ai_disabled",message:...}}` when provider is `undefined`; 502 + `{error:{category:"ai_provider",message:...}}` when the stub throws `AiError`; 422 on missing field; 415 on wrong content-type; 401 on missing bearer. Final case: register a fixed-id history connection, hit `POST /ai/explain`, then `GET /history/export.jsonl` returns an empty body (AI calls do not enter `history.jsonl`).
11. **`docs/deployment.md`** _(modified)_ — add two bullet points under "Optional: Anthropic AI provider" pointing at the new routes and the 404 / 502 behaviour. No change to "Privacy and contract notes" beyond reaffirming the no-history-pollution guarantee.

## Definition of Done

- [ ] `ErrorCategory` extended with `"ai_disabled" | "ai_provider"`; `ContractErrorFilter` maps them to 404 / 502.
- [ ] `AiDisabledError` and `AiUpstreamError` live under `apps/api/src/domain/ai/`, both `extends CategorizedError`.
- [ ] `ExplainSql` and `SuggestSql` use cases live under `apps/api/src/usecase/`; each throws `AiDisabledError` when the provider is undefined and `AiUpstreamError` when the adapter throws.
- [ ] `AiExplainRequestDto` and `AiSuggestRequestDto` validate via class-validator (422 on missing/wrong fields).
- [ ] `AiController` exposes `POST /ai/explain` and `POST /ai/suggest`, both `200 OK` on success, and is **not** decorated with `@UseInterceptors(HistoryRecordingInterceptor)`.
- [ ] `app.module.ts` registers both use cases via `useFactory` with `@Optional() @Inject(AI_PROVIDER)`, and lists `AiController` in `controllers`.
- [ ] Integration spec confirms 200 / 404 / 502 / 422 / 415 / 401 codes, and that an AI call leaves `/history/export.jsonl` empty.
- [ ] `docs/api-contract.md` is unchanged.
- [ ] `apps/api/src/domain/history-record.ts` is unchanged.
- [ ] `apps/api/src/presentation/interceptors/` is unchanged.
- [ ] `docs/deployment.md` notes the two new routes.
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.

## Verification commands

```sh
pnpm --filter @dbboard-web/api test
pnpm format:check
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r build
```

Sanity check the cross-repo contract is untouched:

```sh
git diff --stat develop -- docs/api-contract.md   # expect: no output
```

Sanity check the history schema and interceptor are untouched:

```sh
git diff --stat develop -- apps/api/src/domain/history-record.ts          # expect: no output
git diff --stat develop -- apps/api/src/presentation/interceptors/         # expect: no output
```
