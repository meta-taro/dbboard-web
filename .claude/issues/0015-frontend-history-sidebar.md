# 0015 — Frontend query history sidebar (Phase 5 slice 1)

- **Status:** open
- **Phase:** Phase 5 (frontend) — first slice
- **Opened:** 2026-06-22
- **Closed:** —
- **Branch:** none (direct-to-`develop`, per the Phase 4 slice pattern)
- **Depends on:** [`0009`](./0009-web-history-schema-mirror.md) (persistence layer + `GET /history/export.jsonl` egress), [`0012`](./0012-frontend-sql-editor.md) (the SQL editor page this sidebar attaches to), [`0013`](./0013-frontend-result-grid.md) (the editor layout slice 3 left in place is the surface slice 1 grafts the sidebar onto). Phase 1.5 mobile DoD ([`0006`](./0006-pwa-shell.md)) and Phase 2.5 i18n ([`0008`](./0008-i18n-stage-1.md)) carry over verbatim.
- **Blocks:** Phase 5 slice 2 (schema browser) does not depend on this slice, but they will land side-by-side in `/connections/:id/sql` and the layout choices here (sidebar dock position, collapse rules at 375 px) are the precedent slice 2 reuses.

## Goal

Surface the persisted query history (issue [`0009`](./0009-web-history-schema-mirror.md), `f8154c3`) as a **sidebar on the SQL editor page** scoped to the current connection, with a one-click **replay** that loads the past SQL back into the editor.

After this slice, a user on `/connections/:id/sql` can:

1. see their recent queries for **this** connection — newest first,
2. tell at a glance which ones succeeded vs errored, and how long they took,
3. click any row to load its SQL into the editor (the editor is then in the normal user-edited state — pressing Run executes; no auto-run on click),
4. trigger a manual refresh to pick up records emitted after the page loaded.

The history sidebar runs against the existing operator-only NDJSON egress at `GET /history/export.jsonl`. No new wire-contract endpoint is added. ADR-0017 §8 stays intact — `docs/api-contract.md` is not touched.

## What this is — and what it isn't

**Is:**

- A new pure NDJSON splitter `apps/web/app/composables/internal/parse-ndjson.ts` — `parseNdjson<T>(text: string, validate: (v: unknown) => T | null): T[]`. Handles `\n` / `\r\n` line endings, drops empty trailing lines, silently skips lines that fail JSON parse or `validate`. Pure, no Vue.
- A new auto-imported composable `apps/web/app/composables/useQueryHistory.ts` — fetches the NDJSON egress, parses it through the splitter, filters to records whose `conn === connectionId`, exposes `history` / `state` / `lastError` / `refresh()`. Mirrors the readonly-ref + `apiBase` resolution pattern of `useConnections` / `useQueryExecution`.
- A new auto-imported component `apps/web/app/components/HistorySidebar.vue` — wraps the sidebar list, takes `connectionId` and emits `replay` events. Renders one row per record with truncated SQL + status badge + `{duration_ms} ms`. Empty state + error banner + refresh button. Mobile baseline preserved (44 × 44 touch targets, sidebar collapses below the editor at < 768 px).
- A small reshuffle of `apps/web/app/pages/connections/[id]/sql.vue`: mount `<HistorySidebar :connection-id="connectionId" @replay="onReplay" />` next to the editor, where `onReplay(sql)` writes into `sqlInput` (no auto-run), and call the sidebar's `refresh()` after each `run()` completes so the just-executed query appears.
- New i18n keys under the existing `history.*` namespace (the `history.title` / `history.empty` scaffolding from Phase 2.5 is finally used by a real page; new keys added: `history.refresh`, `history.replay`, `history.status.ok`, `history.status.error`, `history.duration`, `history.error.load`) — wired across all 11 locale bundles.

**Isn't:**

- A wire-contract change. `docs/api-contract.md` is untouched. `GET /history/export.jsonl` already exists as an operator-only egress (per ADR-0017 §8 and `.claude/decisions.md` "2026-06-05 — Query-history persistence mirrors desktop ADR-0017"); this slice consumes it from the web UI, which lives on the same origin and is allowed to call its own operator endpoints.
- A new web-only `GET /history` JSON endpoint. The export endpoint already does the job; a parallel JSON endpoint would duplicate the surface for no win at current data volumes (the in-memory store is bounded by process lifetime and a single user session is at most a few hundred records).
- Pagination / search / filter / delete / per-record auth. All deferred — current store is in-memory, and a single-user dev / self-hosted single-tenant deployment doesn't need them for the slice-1 surface.
- A Postgres history adapter or the reader-side `v` / `status` drop counter (the second is explicitly deferred per ticket `0009` DoD). The in-memory writer guarantees `v: 1`; the splitter silently drops parse-fail lines and the validator returns `null` for unknown `v`, so unknown-version records simply never reach the rendered list.
- Auto-refresh / polling. The sidebar refreshes (a) once on mount and (b) after each user-initiated `run()` from the editor. No background timer.
- Schema browser tree view. That is slice 2 (a separate ticket).
- Replay-and-execute. Clicking a row loads SQL into the editor only — the user still presses Run. Auto-execute would be surprising and would risk re-running an expensive query by accident.

## Scope

1. **`apps/web/app/composables/internal/parse-ndjson.ts`** _(new, pure)_ —
   ```ts
   export function parseNdjson<T>(text: string, validate: (v: unknown) => T | null): T[] {
     const out: T[] = [];
     for (const raw of text.split(/\r?\n/)) {
       const line = raw.trim();
       if (line === "") continue;
       let parsed: unknown;
       try {
         parsed = JSON.parse(line);
       } catch {
         continue;
       }
       const validated = validate(parsed);
       if (validated !== null) out.push(validated);
     }
     return out;
   }
   ```
   No Vue, no i18n; unit-tested without `@nuxt/test-utils`.
2. **`apps/web/app/composables/useQueryHistory.ts`** _(new, auto-imported)_ — same shape as `useQueryExecution`:
   - Public types: re-exported `HistoryRecord` (matches the API's `domain/history-record` shape, minus the Zod runtime — duplicated as a `type` here because the web app does not import from `apps/api/`).
   - `useQueryHistory(connectionId: string, options?: { apiBase?: string })` returns `{ history: Readonly<Ref<...>>, state, lastError, refresh }`.
   - `refresh()` fetches `${apiBase}/history/export.jsonl` with `Accept: application/x-ndjson` via `apiFetch` (returns text, not JSON — see § Test patterns for the response-text mode), pipes it through `parseNdjson(..., validateHistoryRecord)`, filters by `record.conn === connectionId`, sorts newest-first by `ts`, and stores the result.
   - `validateHistoryRecord` is a defensive type-guard local to this file — checks `v === 1`, `status ∈ {"ok", "error"}`, `typeof ts === "string"`, etc. (NOT the full Zod schema — the schema lives in `apps/api/` and the web bundle should not pull Zod for this.) Unknown-shape lines return `null` so the splitter drops them.
   - `lastError` reuses `CategorisedError` from `internal/i18n-error.ts` so the surface stays uniform.
   - Auto-refresh: `onMounted` calls `refresh()` once (mirrors `useConnections`'s mount-time refresh).
3. **`apps/web/app/components/HistorySidebar.vue`** _(new, auto-imported)_ —
   - Props: `{ connectionId: string }`.
   - Emits: `replay: (sql: string) => void`.
   - Setup: instantiates `useQueryHistory(connectionId)`; exposes `refresh` to the parent via `defineExpose({ refresh })` so the page can re-fetch after each `run()`.
   - Template: a `<aside data-testid="history-sidebar">` containing a header (`<h3>{{ t("history.title", { count: history.length }) }}</h3>` + a `<button data-testid="history-refresh">{{ t("history.refresh") }}</button>`), an error banner when `lastError` is set, an empty-state paragraph when `history.length === 0`, and a `<ul>` with one `<li data-testid="history-row">` per record. Each row: a status badge (`data-testid="history-status"` carrying class `badge--ok` or `badge--error`), the truncated SQL (max 60 chars, ellipsis), a `<time>` element with the `ts`, the `{duration_ms} ms` line, and a replay `<button data-testid="history-replay">` that emits `replay(record.sql)`.
   - Mobile: at < 768 px the sidebar stacks below the editor (`flex-direction: column` on the wrapping container in `sql.vue`); at ≥ 768 px the editor + sidebar sit side-by-side with the sidebar at 280 px fixed width. Touch targets ≥ 44 × 44 px on the refresh and replay buttons.
4. **`apps/web/app/pages/connections/[id]/sql.vue`** _(modified)_ —
   - Add `import HistorySidebar from "../../../components/HistorySidebar.vue"`.
   - Add a `historyRef = ref<InstanceType<typeof HistorySidebar> | null>(null)` and wire `<HistorySidebar ref="historyRef" :connection-id="connectionId" @replay="onReplay" />`.
   - `onReplay(sql: string) { sqlInput.value = sql; }` — no auto-run.
   - After `onRun()` completes (success or failure), call `historyRef.value?.refresh()` so the most recent record shows up in the sidebar without a manual click. Wrap in `await` so the test can pin the refresh-on-run behaviour.
   - Layout: wrap the existing `editor-label` / `editor` / `actions` / `result-area` in a `.editor-column` and place the sidebar in a `.history-column`; at ≥ 768 px the parent flex container sits them side-by-side.
5. **`apps/web/i18n/locales/*.json`** _(modified)_ — extend the existing `history.*` block in all 11 locales:
   ```jsonc
   "history": {
     "title": "History ({count})",
     "empty": "(no recent queries)",
     "refresh": "Refresh",
     "replay": "Replay",
     "status": {
       "ok": "OK",
       "error": "Error"
     },
     "duration": "{ms} ms",
     "error": {
       "load": "Failed to load history."
     }
   }
   ```
   Re-pin `tests/i18n-locale-parity.test.ts` to include `history.refresh`, `history.replay`, `history.status.ok`, `history.status.error`, `history.duration`, `history.error.load`. Keep the existing `history.title` / `history.empty` pins and the ICU placeholder check on `history.title` (`{count}`); add an ICU placeholder check on `history.duration` (`{ms}`).
6. **Tests.**
   - `apps/web/tests/parse-ndjson.test.ts` _(new)_ — pure unit: empty input → `[]`, single line, multiple `\n` lines, `\r\n` lines, trailing empty line dropped, malformed JSON line silently skipped, `validate` returning `null` drops the line, identity-`validate` round-trip on a fixture.
   - `apps/web/tests/use-query-history.test.ts` _(new)_ — mock `internal/http`'s `apiFetch` to return raw NDJSON text. Cases: empty store → `history === []` + `state === "idle"`, two records mixed-conn → only the matching `conn` survives, newest-first sort by `ts`, unknown-`v` line dropped, malformed line dropped, fetch failure → `lastError` populated + `state === "error"`. Run is mount-time only when `connectionId` is set; calling `refresh()` re-fetches.
   - `apps/web/tests/history-sidebar.test.ts` _(new)_ — mount the component with the same `apiFetch` mock; assert: header text shows the count, empty state renders when there are zero records for this connection, rows render with status badge + truncated SQL + duration, clicking a replay button emits `replay` with the original (untruncated) SQL, clicking the refresh button calls `apiFetch` a second time, error banner shows when fetch fails.
   - `apps/web/tests/sql-page.test.ts` _(modified)_ — adapt the existing slice-3 tests:
     - Assert the sidebar mounts on the page (presence of `history-sidebar` testid).
     - Add a test that emits `replay` from a stubbed sidebar and asserts `sqlInput` (via the editor's `value`) updates without `run` being called.
     - Add a test that asserts the sidebar's `refresh()` is called after each `run()` completes — both on success and after an error. Use a `defineExpose` spy approach: mount the page with a stub `HistorySidebar` whose `refresh` is a `vi.fn()`, then trigger Run and assert the call.
   - `apps/web/tests/i18n-locale-parity.test.ts` _(modified)_ — pin the six new history keys, add `history.duration` placeholder check.

## Out of scope

- **Pagination / search / filter / delete.** Slice-1 ships the read view only; the in-memory store is small enough to render in full.
- **Auto-refresh on a timer.** Refresh fires on mount and after Run. A timer is a follow-up.
- **A web-only JSON `GET /history` endpoint.** Existing NDJSON egress is sufficient.
- **Reader-side `v` / `status` drop counter.** Deferred per `0009` DoD; current behaviour silently drops via the validator returning `null`.
- **Schema browser.** Slice 2.
- **Auto-execute on replay.** Click loads SQL into the editor; the user presses Run.
- **Capability gating.** `GET /capabilities` integration is still deferred.

## Tasks

- [ ] Draft this issue and add a pointer from `.claude/project-status.md` "Ready to start".
- [ ] Write the failing `parse-ndjson` unit test (RED).
- [ ] Write the failing `use-query-history` composable test (RED).
- [ ] Write the failing `history-sidebar` component test (RED).
- [ ] Update `sql-page.test.ts` for the sidebar-mount + replay + refresh-on-run assertions (RED).
- [ ] Update `i18n-locale-parity.test.ts` pins for the six new history keys + `history.duration` placeholder (RED).
- [ ] Implement `app/composables/internal/parse-ndjson.ts` (GREEN).
- [ ] Implement `app/composables/useQueryHistory.ts` (GREEN).
- [ ] Implement `app/components/HistorySidebar.vue` (GREEN).
- [ ] Wire the sidebar into `app/pages/connections/[id]/sql.vue` (GREEN); add `onReplay` and refresh-on-run.
- [ ] Extend all 11 locale JSONs with the new `history.*` keys.
- [ ] Update `.claude/project-status.md` (Phase 5 → in progress; record slice 1 landed) and `.claude/roadmap.md` (tick the slice 1 DoD lines).
- [ ] Verification chain: `pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`.

## Definition of Done

- [ ] `/connections/:id/sql` shows a `history-sidebar` aside scoped to the current connection.
- [ ] Empty state renders when no records match the connection; rows render newest-first with status badge + truncated SQL + duration.
- [ ] Replay button on a row loads the SQL into the editor; no auto-run.
- [ ] After each Run, the sidebar refreshes so the just-executed query appears.
- [ ] Manual refresh button re-fetches `/history/export.jsonl`.
- [ ] Unknown-`v` / malformed lines silently skipped (no console noise, no `lastError`).
- [ ] At 375 px the sidebar stacks below the editor; at ≥ 768 px they sit side-by-side. Refresh and replay buttons meet the 44 × 44 px touch target.
- [ ] All 11 locale files carry the six new `history.*` keys; parity test green.
- [ ] No regression on slice 1 / 2 / 3 surfaces: connection list, SQL editor, result grid, IME guard, error banner still pass their existing assertions.
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] No file under `apps/api/`, `docs/api-contract.md`, or `docs/decisions.md` is touched. (Web-only slice, consumes the existing operator NDJSON egress.)
- [ ] `.claude/project-status.md` + `.claude/roadmap.md` updated in the same series of commits.

## Test patterns

`apiFetch` is the same indirection used by `useConnections` and `useQueryExecution` (`apps/web/app/composables/internal/http.ts` re-exports Nuxt's `$fetch`). Nuxt's `$fetch` auto-detects JSON when the server replies with `Content-Type: application/json` and returns the parsed value; for `application/x-ndjson` it returns the response body as a `string`. The mock pattern:

```ts
vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(async () => `${JSON.stringify(recordA)}\n${JSON.stringify(recordB)}\n`),
}));
```

The composable types `apiFetch<string>(...)` explicitly to make the text-mode contract visible to readers.

The history-sidebar component test mounts under happy-dom and stubs `apiFetch` the same way as `useConnections.test.ts`. The replay assertion mounts the component, awaits a `nextTick()` for the initial `refresh()` to settle, then clicks the first `history-replay` button and asserts the emitted `replay` event payload equals the original (untruncated) `record.sql`.

The sql-page test's refresh-on-run case uses a `defineComponent({ name: "HistorySidebarStub", setup(_, { expose }) { expose({ refresh: vi.fn() }); return () => h("aside", { "data-testid": "history-sidebar" }); } })` stub registered via `global.stubs`. Without the stub, mounting the real sidebar would also fire its own mount-time `apiFetch`, and asserting "the page called `refresh()` after Run" would race with "the sidebar called `refresh()` on mount". Stubbing decouples the page-level assertion from the sidebar internals.

## References

- Persistence layer: [`0009`](./0009-web-history-schema-mirror.md), `apps/api/src/presentation/history.controller.ts`, `apps/api/src/usecase/export-history.use-case.ts`.
- Slice 2 precedent (page-level conventions): [`0012`](./0012-frontend-sql-editor.md), [`0013`](./0013-frontend-result-grid.md).
- Slice 1 precedent (composable conventions): [`0011`](./0011-frontend-connection-list.md), `apps/web/app/composables/useConnections.ts`.
- Web ADR: `.claude/decisions.md` "2026-06-05 — Query-history persistence mirrors desktop ADR-0017 (web Stage 2)".
- Desktop ADR-0017: `dbboard@62ed834:docs/decisions.md` (search `## ADR-0017`).
- Mobile DoD baseline: [`0006`](./0006-pwa-shell.md).
- i18n baseline: [`0008`](./0008-i18n-stage-1.md), `apps/web/tests/i18n-locale-parity.test.ts`.
- Phase plan: `.claude/roadmap.md` § Phase 5.
