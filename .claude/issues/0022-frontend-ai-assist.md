# 0022 — Frontend AI assist panel (Phase 6 Slice 3)

- **Status:** done (2026-06-26)
- **Phase:** web-side Phase 6 Slice 3 (UI layer on top of the Slice 2 `POST /ai/explain` + `POST /ai/suggest` routes)
- **Opened:** 2026-06-26
- **Closed:** 2026-06-26
- **Branch:** none (direct-to-`develop`, per the Phase 4/5/6 slice pattern)
- **Depends on:** [`0019`](./0019-ai-provider-anthropic-stage1.md) (provider seam), [`0020`](./0020-ai-explain-suggest-http-routes.md) (HTTP routes + `ai_disabled` / `ai_provider` envelope categories).
- **Anchors:**
  - Web roadmap entry: [`../roadmap.md`](../roadmap.md) § "Phase 6 — Optional AI provider interface" — Slice 3 closes the last open DoD bullet (Nuxt UI surface).
  - Slice 2 closeout in [`../project-status.md`](../project-status.md) — defines the two new wire categories (`ai_disabled` → 404, `ai_provider` → 502) and the no-history canary.
  - Web ADR entry "2026-06-24 — AI Phase 6: no HTTP contract mirror needed (desktop ADR-0023 Stage 1)" in [`../decisions.md`](../decisions.md).

## Goal

Land the Nuxt-side UI surface that lets a maintainer actually use the AI routes shipped in Slice 2 — without that, Phase 6 is "implemented" but invisible. Closes the last Phase 6 DoD bullet (Nuxt `useAiAssist()` + `AiPanel.vue` + 11-locale i18n).

While here, fix a defect introduced by Slice 2: the web-side `i18n-error.ts` bridge was not extended when API-side `ErrorCategory` grew `ai_disabled` / `ai_provider`. The cast in `parseError` accepts the new categories at runtime, but `toI18nKey` falls through to `error.prefix.${raw}` — emitting the never-defined keys `error.prefix.ai_disabled` / `error.prefix.ai_provider` (underscore, not hyphen). Until Slice 3 ships, the AI routes have no consumer so the defect is latent — Slice 3 surfaces it, so Slice 3 fixes it.

## What this is — and what it isn't

**Is:**

- A new `apps/web/app/composables/useAiAssist.ts` exposing:
  - `lastResponse: Readonly<Ref<{text: string; model: string; mode: "explain" | "suggest"} | null>>` — the discriminator is web-side bookkeeping so the panel knows which output slot the response belongs to (the wire shape itself does not carry `mode`).
  - `state: Readonly<Ref<"idle" | "loading" | "error">>` — single shared state since both methods route through the same composable and the panel disables both buttons while one is in flight.
  - `lastError: Readonly<Ref<CategorisedError | null>>` — same shape as every other composable in the repo (`useConnections`, `useQueryExecution`, `useQueryHistory`, `useSchemaBrowser`).
  - `explain(sql: string, dialect?: string): Promise<void>` — `POST /ai/explain` `{sql, dialect?}`.
  - `suggestSql(prompt: string, dialect?: string): Promise<void>` — `POST /ai/suggest` `{prompt, dialect?}`. Named `suggestSql` (not `suggest`) to avoid collision with any global / future imports.
  - `apiBase` test-injection option mirroring every other composable.
- A new `apps/web/app/components/AiPanel.vue` — stacked two-section panel (explain on top, suggest below), single shared error banner, shared spinner. The "disabled mode" UI is triggered when `lastError?.category === "ai_disabled"` — both buttons disable and a single neutral "AI is not configured" message replaces the error banner (the route returning 404 with `ai_disabled` envelope is the documented "feature off" signal per Slice 2; tabs/buttons that retry-on-click would just keep hitting the same 404).
- Extension of `apps/web/app/composables/internal/i18n-error.ts`:
  - `ErrorCategory` union gains `ai_disabled | ai_provider`.
  - `toI18nKey` extends the underscore→hyphen mapping for both (`ai_disabled → ai-disabled`, `ai_provider → ai-provider`).
- New i18n keys across all 11 locale files (`en` / `ja` / `ko` / `zh-CN` / `zh-TW` / `de` / `fr` / `es` / `pt-BR` / `ru` / `it`):
  - `ai.heading`, `ai.section.explain`, `ai.section.suggest`
  - `ai.explain.button`, `ai.explain.empty`
  - `ai.suggest.prompt-label`, `ai.suggest.prompt-placeholder`, `ai.suggest.button`, `ai.suggest.insert`, `ai.suggest.empty`
  - `ai.dialect.label`, `ai.dialect.placeholder`
  - `ai.state.loading`
  - `ai.response.model` — parameterised with `{model}`; placeholder check goes into the parity test alongside the existing `{count}` / `{ms}` / `{rows}` set.
  - `ai.disabled.heading`, `ai.disabled.body`
  - `error.prefix.ai-disabled`, `error.prefix.ai-provider`
- `i18n-locale-parity.test.ts` re-pinned with the new key set (18 new leaves).
- `sql.vue` mount: `<AiPanel>` placed below the editor's `result-area` in the existing `editor-column`, receives the current editor SQL as a `currentSql` prop so the explain button can act on what the user is composing, emits `insert` for the suggest output's "Insert into editor" button which the page wires into the existing `onInsertIdentifier` caret-aware splicer.

**Isn't:**

- Not a streaming UI. `AiCapabilities` is `{streaming: false, functionCalling: false}` in Stage 1; the response renders all at once when the promise resolves.
- Not a `/ai/capabilities` discovery call. There is no such route — clients infer the disabled state from a 404 `ai_disabled` envelope on the first explain/suggest attempt (Slice 2 design). The panel does not eagerly probe.
- Not an HTTP contract change. `docs/api-contract.md` stays untouched (web-only AI routes per ADR-0023).
- Not a persisted-key UI. Stage 2 territory per ADR-0023 Decision 9.
- Not a model selector. The model is server-side configuration (`DBBOARD_ANTHROPIC_MODEL`); the panel renders `ai.response.model` `{model}` as a label so the operator sees what answered.
- Not an E2E suite extension. The existing `apps/web/e2e/` suite stays Playwright-free of AI calls — adding a real Anthropic call to E2E would require a key, and stubbing it would just retest what unit tests cover. The mobile flow is `connection-flow.spec.ts` and stays as-is.

## TDD plan

1. **Red** — `apps/web/tests/i18n-error.test.ts` (new file if absent; otherwise extend): assert `toI18nKey("ai_disabled") === "error.prefix.ai-disabled"` and `toI18nKey("ai_provider") === "error.prefix.ai-provider"`. **Green** — extend the union + mapping in `i18n-error.ts`.
2. **Red** — `apps/web/tests/use-ai-assist.test.ts`: cover idle / loading / done(explain) / done(suggest) / error(ai_disabled) / error(ai_provider) / error(generic) plus the wire body shapes for both methods (with and without `dialect`). **Green** — implement `useAiAssist` mirroring `useSchemaBrowser`'s readonly-ref + apiBase pattern.
3. **Red** — `apps/web/tests/ai-panel.test.ts`: render the panel against a mocked composable harness (or against the real composable with mocked `apiFetch`); assert the explain button posts the editor SQL prop, the suggest button posts the prompt textarea value, the suggest output's "Insert" button emits the wire `text`, the disabled-mode UI replaces the error banner when category is `ai_disabled`. **Green** — implement the panel.
4. **Green** — translate `ai.*` and `error.prefix.ai-*` across 10 non-English locales. Re-pin the parity test. (No red phase — parity test failures are the indicator and they'll show the missing keys when (3) lands.)
5. **Green** — wire `<AiPanel>` into `sql.vue`; extend `sql-page.test.ts` only if existing assertions depend on the new mount (keep the test surface minimal — sql-page already covers the editor + sidebar; AiPanel has its own test).

## Verification

- `pnpm format:check`
- `pnpm -r typecheck`
- `pnpm -r lint`
- `pnpm -r test`
- `pnpm -r build`

Expected after Slice 3:

- **API**: 323 + 2 skipped (untouched).
- **Web**: was 272 — adds ~7 i18n-error specs + ~10 composable specs + ~8 panel specs + parity (no count change) = ~297.
- All locales pass parity + ICU placeholder checks for the new `ai.response.model` `{model}` token.

## DoD

- [x] `useAiAssist()` composable lives at `apps/web/app/composables/useAiAssist.ts` with the documented surface.
- [x] `AiPanel.vue` component lives at `apps/web/app/components/AiPanel.vue` and renders explain + suggest sections.
- [x] `i18n-error.ts` recognises `ai_disabled` and `ai_provider` and routes both to hyphen i18n keys.
- [x] All 11 locale files include the 18 new leaves (16 `ai.*` + 2 `error.prefix.ai-*`); parity test re-pinned.
- [x] `sql.vue` mounts `<AiPanel>` with the current editor SQL as a prop and wires `@insert` into the existing caret-aware splicer.
- [x] `ai_disabled` envelope (HTTP 404) renders a neutral "AI not configured" panel state rather than a generic error.
- [x] No HTTP contract change; no API code touched; no E2E suite touched.
- [x] Full verification chain green.
- [x] Phase 6 DoD bullet for Nuxt UI ticked in `roadmap.md`; `project-status.md` records the closeout. **Phase 6 fully closed.**

## Closeout (2026-06-26)

Landed on `develop` via the per-slice commit sequence (no PR; matches the Phase 4/5/6 direct-to-`develop` cadence):

1. **Issue open** — this file.
2. **i18n-error bridge** — `apps/web/app/composables/internal/i18n-error.ts` widens `ErrorCategory` to include `ai_disabled | ai_provider`; `toI18nKey` maps both to the underscore→hyphen i18n key namespace (`error.prefix.ai-disabled` / `error.prefix.ai-provider`). Test scaffold at `apps/web/tests/i18n-error.test.ts` pins all category mappings (5 prior + 2 new).
3. **`useAiAssist` composable** — `apps/web/app/composables/useAiAssist.ts` exposes the documented `{lastResponse, state, lastError, explain, suggestSql}` surface; readonly refs; `apiBase` test seam; single shared state across both methods so the panel can disable both buttons during any in-flight call. Test at `apps/web/tests/use-ai-assist.test.ts` (10 specs) covers idle / loading / done (both methods) / error (`ai_disabled` + `ai_provider` + generic) / `dialect` passthrough / response-replacement / error-clear.
4. **`AiPanel.vue` component** — `apps/web/app/components/AiPanel.vue` renders two stacked sections (explain on top, suggest below) sharing a `dialect` input + spinner + error banner. `isDisabledMode` latches on `lastError?.category === "ai_disabled"`, swaps the error banner for a neutral "AI is not configured" notice, and disables both action buttons (no eager probe — the first 404 is the disabled-state signal per Slice 2). Suggest output exposes an "Insert into editor" button that emits the wire `text`. Test at `apps/web/tests/ai-panel.test.ts` (9 specs).
5. **11-locale `ai.*` keys + parity re-pin** — 16 `ai.*` keys + 2 `error.prefix.ai-*` keys translated across `en` / `ja` / `ko` / `zh-CN` / `zh-TW` / `de` / `fr` / `es` / `pt-BR` / `ru` / `it`. Parity test (`apps/web/tests/i18n-locale-parity.test.ts`) re-pinned with the new key set; ICU `{model}` placeholder check added for `ai.response.model`.
6. **`sql.vue` wiring** — `<AiPanel :current-sql="sqlInput" @insert="onInsertIdentifier" />` mounted in the existing `.editor-column` below `.result-area`; the existing caret-aware `onInsertIdentifier` handler is reused as-is for suggest-insert. Tests in `apps/web/tests/sql-page.test.ts` extended with 2 specs: panel-mounts + `currentSql` prop tracks editor value; insert event reuses the same splicer path as the schema browser. (Reactivity gotcha: read live props via `wrapper.findComponent({name}).props()`, not a setup-time spy that fires once.)
7. **Status + roadmap + issue closeout** — this commit.

**Verification chain (all green):**

- `pnpm format` (write mode, clean)
- `pnpm -r typecheck`
- `pnpm -r lint` — 0 errors; 3 pre-existing warnings (one `<input/>` self-closing in `AiPanel.vue` matches the established pattern in `connections/index.vue`, not a regression)
- `pnpm -r test` — **API 323 + 2 skipped; Web 332** (was 272; +60 from the new specs + the 30 locale parity entries that fan out across the 10 non-English locales)
- `pnpm -r build` — Nuxt 2.91 MB / 727 kB gzip; Nest clean

**Untouched (verified by `git diff --stat develop` before the slice opened):** `docs/api-contract.md` (web-only AI per ADR-0023), `apps/api/**` (no API change in this slice), `apps/web/e2e/**` (no E2E added — would require a real Anthropic key or stub the same wire unit tests already cover).
