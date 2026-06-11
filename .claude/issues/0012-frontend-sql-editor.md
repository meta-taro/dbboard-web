# 0012 — Frontend SQL editor (Phase 4 slice 2)

- **Status:** open
- **Phase:** Phase 4 (frontend) — second slice
- **Opened:** 2026-06-11
- **Closed:** —
- **Suggested branch:** `feature/0012-frontend-sql-editor`
- **Depends on:** [`0011`](./0011-frontend-connection-list.md) (a registered connection to target and the `useConnections()` precedent), [`0003`](./0003-nestjs-http-surface.md) (`POST /connections/:id/query` HTTP surface), [`0004`](./0004-postgres-adapter.md) (a real driver so `Run` returns something other than `null`-driver placeholders). Phase 1.5 mobile DoD ([`0006`](./0006-pwa-shell.md)) and Phase 2.5 i18n ([`0008`](./0008-i18n-stage-1.md)) carry over verbatim.
- **Blocks:** Phase 4 slice 3 (result grid with virtualisation) — slice 3 swaps the placeholder summary for the real grid and reuses the same `useQueryExecution` composable.

## Goal

Land the second user-facing Phase 4 surface: a **SQL editor page** at `/connections/:id/sql` that lets a user

1. type SQL into a textarea,
2. trigger `POST /connections/:id/query` with `{ sql }` via a `Run` button (or `Ctrl/Cmd+Enter` while the editor has focus),
3. see a one-line summary of the returned `QueryResult` (column count, row count, `rows_affected`) plus a tiny JSON preview of `rows[0]`.

That is the entire slice. No Monaco, no CodeMirror, no virtualised grid, no value-cell formatting (numbers / base64 `{ $blob }` decoding) — those land in slice 3.

## What this is — and what it isn't

**Is:**

- A Nuxt dynamic route at `apps/web/app/pages/connections/[id]/sql.vue` that reads `useRoute().params.id` and binds it to a new `useQueryExecution(connectionId)` composable.
- A `useQueryExecution()` composable that owns `$fetch` against `runtimeConfig.public.apiBaseUrl` for one endpoint only: `POST /connections/:id/query`.
- A plain `<textarea data-testid="sql-input">` editor with a focus-scoped `Ctrl/Cmd+Enter` keydown handler that calls the same `run()` the button calls.
- A minimal result placeholder: a `<p data-testid="result-summary">` with `{columns} columns × {rows} rows, {affected} rows affected` plus a `<pre data-testid="result-preview">` of `JSON.stringify(rows[0])` when `rows.length > 0`.
- Mobile-first layout following the Phase 1.5 DoD (375 × 667 baseline, 44 × 44 touch targets, full-width textarea on 375 px).
- A `Run SQL` `<NuxtLink :to="`/connections/${row.id}/sql`">` added to each row of `/connections` so the page is reachable.
- i18n through the 11 locale files (`apps/web/i18n/locales/*.json`) under a repurposed `sql.*` key namespace, parity-tested by `i18n-locale-parity.test.ts`. The existing `error.prefix.*` namespace is re-used as-is.
- A pure refactor that lifts `toI18nKey`, `parseError`, `ErrorCategory`, and `CategorisedError` out of `useConnections.ts` into `apps/web/app/composables/internal/i18n-error.ts` so both composables share one source of truth for the wire-underscore → hyphen bridge.

**Isn't:**

- A wire-contract change. `apps/web` consumes the existing `POST /connections/:id/query` surface; `docs/api-contract.md` is untouched.
- A Monaco / CodeMirror editor. Plain `<textarea>` for slice 2; rich editor is slice 3 polish.
- A virtualised result grid. `<p>` + `<pre>` placeholder for slice 2; the grid is slice 3.
- A query-history viewer. Phase 4 slice 4 (TBD) consumes `GET /history/export.jsonl`.
- A document-level keyboard shortcut. `Ctrl/Cmd+Enter` is wired on the textarea itself (focus-scoped) — global shortcuts have accessibility nuances that are out of scope here.
- A driver-capability gate. `GET /capabilities` integration is deferred to a later slice; the page runs whatever SQL the user types.
- An IME-aware Enter handler. happy-dom does not implement `KeyboardEvent.isComposing`; slice 2 omits the guard and accepts the limitation. Real IME-aware editor handling is slice 3's concern.

## Scope

1. **`apps/web/app/composables/internal/i18n-error.ts`** _(refactor, no behaviour change)_ — lift `toI18nKey()`, `parseError()`, and the `ErrorCategory` / `CategorisedError` types out of `useConnections.ts` so both composables share one source of truth. `useConnections.ts` re-imports verbatim; the existing `useConnections.test.ts` keeps passing without changes (public behaviour unchanged).
2. **`apps/web/app/composables/useQueryExecution.ts`** — owns the query I/O for one connection.
   - `run(sql: string): Promise<void>` — `POST /connections/:id/query` with `{ sql }`. Populates `result` on success; populates `lastError` and flips `state` to `"error"` on the categorised error envelope.
   - `result: Readonly<Ref<QueryResult | null>>` — `null` until the first successful call, then the most recent `QueryResult`.
   - `state: Readonly<Ref<"idle" | "loading" | "error">>` — same vocabulary as `useConnections`.
   - `lastError: Readonly<Ref<CategorisedError | null>>` — wire-format underscore is normalised through the shared `toI18nKey()`.
   - No `onMounted` auto-run. Run is user-initiated only.
3. **`apps/web/app/pages/connections/[id]/sql.vue`** — the page UI.
   - Reads connection id from `useRoute().params.id`.
   - `<textarea data-testid="sql-input">` (full width on 375 px, `rows="6"` baseline), `<button data-testid="run-button">` with disabled-while-loading semantics, error banner that mirrors the `/connections` page pattern.
   - Result placeholder: `result-summary` paragraph + `result-preview` block when `rows[0]` exists; `result-empty` copy when `result === null`.
   - Focus-scoped `Ctrl/Cmd+Enter` on the textarea calls the same `run()`.
4. **`apps/web/app/pages/connections.vue`** — add a `Run SQL` `<NuxtLink>` per row pointing at `/connections/${row.id}/sql`.
5. **`apps/web/i18n/locales/*.json`** — replace the Phase 1 `sql.*` scaffold (`sql.heading` / `sql.run-button` — referenced only by the parity test, not by any rendered template) with the new namespace below, translated across all 11 locales:

   ```jsonc
   "sql": {
     "title": "Run SQL",
     "editor": { "label": "SQL" },
     "run": "Run",
     "running": "Running…",
     "result": {
       "empty": "Run a query to see results.",
       "summary": "{columns} columns × {rows} rows, {affected} rows affected.",
       "preview-heading": "First row"
     },
     "link-from-row": "Run SQL"
   }
   ```

6. **Tests.**
   - `apps/web/tests/useQueryExecution.test.ts` — mock `apiFetch`; cover: `run()` POSTs `{ sql }` to the right URL, success populates `result`, error envelope populates `lastError` + flips `state` to `"error"`, `type_conversion` normalises to `error.prefix.type-conversion`, fallback to `connection` when envelope is unparseable, `state` transitions `idle → loading → idle` on success, no auto-run at mount, a second `run()` replaces `result` (no stale data).
   - `apps/web/tests/sql-page.test.ts` — `vi.mock` `useQueryExecution` + `vue-i18n` + `vue-router` (`useRoute`); cover: empty-state copy, Run button dispatches `run(sql)`, `Ctrl+Enter` and `Meta+Enter` on the textarea dispatch `run(sql)`, summary renders with all three numbers when `result` is set, preview hidden when `rows.length === 0`, error banner with i18nKey, Run button `disabled` while `state === "loading"`, the composable receives the route id from the mocked `useRoute()`.

## Out of scope

- **Monaco / CodeMirror.** Slice 3 polish.
- **Virtualised result grid + value-cell formatting** (numbers, base64 `{ $blob }` decoding, null rendering). Slice 3.
- **Multi-statement scripts.** Single `sql` string per request; the backend handles whatever it accepts.
- **Query cancellation.** Backend has no `AbortSignal` plumbing yet; deferred.
- **Saved queries / query history viewer.** Phase 4 slice 4.
- **Capability-driven UI dimming.** Deferred to a later slice.
- **Auth.** Backend still emits `actor: null`; the UI does not gate the page.
- **Document-level keyboard shortcuts.** Focus-scoped only for slice 2.
- **IME composition guard.** happy-dom can't model it; slice 3.

## Tasks

- [ ] Draft this issue and link it from `.claude/project-status.md` "Ready to start".
- [ ] Refactor: lift `toI18nKey` + `parseError` + `ErrorCategory` + `CategorisedError` into `apps/web/app/composables/internal/i18n-error.ts`; re-export from `useConnections.ts`; existing `useConnections.test.ts` stays green (no test changes).
- [ ] Write failing tests in `apps/web/tests/useQueryExecution.test.ts` and `apps/web/tests/sql-page.test.ts` (RED).
- [ ] Implement `apps/web/app/composables/useQueryExecution.ts` to make the composable test pass (GREEN).
- [ ] Implement `apps/web/app/pages/connections/[id]/sql.vue` to make the page test pass (GREEN).
- [ ] Add `Run SQL` link to each row in `apps/web/app/pages/connections.vue`.
- [ ] Replace the legacy `sql.*` block with the new namespace in all 11 locale JSON files; verify `i18n-locale-parity.test.ts` still passes.
- [ ] Update `.claude/project-status.md` (move 0012 Ready → In-progress → Completed) and `.claude/roadmap.md` (note slice 2 of Phase 4 landed).
- [ ] Verification chain: `pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`.

## Definition of Done

- [ ] `/connections/:id/sql` page renders against a running `apps/api`.
- [ ] Typing `SELECT 1 AS x` and pressing Run posts to `POST /connections/:id/query` and surfaces a one-line summary.
- [ ] `Ctrl/Cmd+Enter` on the focused textarea triggers the same run path as the button.
- [ ] Backend categorised error envelope (`{ error: { category, message } }`) surfaces in the UI through `error.prefix.<category>` + the raw message.
- [ ] Run button is disabled while `state === "loading"`.
- [ ] All 11 locale files carry the new `sql.*` keys; parity test green.
- [ ] Touch targets ≥ 44 × 44 on every interactive element (Run button, the `Run SQL` row link, textarea has full-width hit area).
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] No file under `apps/api/`, `docs/api-contract.md`, or `docs/decisions.md` is touched. (Web-only slice.)
- [ ] `.claude/project-status.md` + `.claude/roadmap.md` updated in the same PR.

## References

- HTTP surface this slice consumes: `apps/api/src/presentation/query.controller.ts` (`POST /query` and `POST /connections/:id/query`), `apps/api/src/usecase/execute-query.use-case.ts` (response shape `QueryResult`), `apps/api/src/presentation/dto/query-request.dto.ts` (request shape `{ sql }`), `docs/api-contract.md` § `POST /query`, § `QueryResult`, § Errors.
- Mobile DoD baseline: [`0006`](./0006-pwa-shell.md).
- i18n baseline: [`0008`](./0008-i18n-stage-1.md), `apps/web/tests/i18n-locale-parity.test.ts`.
- Slice 1 precedent: [`0011`](./0011-frontend-connection-list.md).
- Phase plan: `.claude/roadmap.md` § Phase 4.
