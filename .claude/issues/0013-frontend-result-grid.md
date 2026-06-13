# 0013 — Frontend result grid + IME composition guard (Phase 4 slice 3)

- **Status:** open
- **Phase:** Phase 4 (frontend) — third slice
- **Opened:** 2026-06-12
- **Closed:** —
- **Suggested branch:** `feature/0013-frontend-result-grid`
- **Depends on:** [`0012`](./0012-frontend-sql-editor.md) (the SQL editor page and `useQueryExecution()` composable that emits the `QueryResult` envelope this slice renders; the `Value` / `Column` / `QueryResult` types are re-imported, not re-declared), [`0004`](./0004-postgres-adapter.md) (a real driver so the grid renders something other than `null`-driver placeholders), [`0005`](./0005-row-cap-body-limit-conformance.md) (`ROW_CAP = 10_000` is the upper bound the virtualiser must comfortably handle). Phase 1.5 mobile DoD ([`0006`](./0006-pwa-shell.md)) and Phase 2.5 i18n ([`0008`](./0008-i18n-stage-1.md)) carry over verbatim.
- **Blocks:** Phase 4 slice 4 (Playwright mobile E2E) — slice 4 exercises the grid + IME guard from real browsers.

## Goal

Replace the slice-2 placeholder `result-summary` + `result-preview` on `/connections/:id/sql` with a real **virtualised result grid** that can comfortably render the contract's worst case (10,000 rows × ~20 columns), and fix the IME composition gap that slice 2 explicitly punted (`event.isComposing` was not testable under happy-dom and got deferred here).

After this slice, a user can:

1. type SQL,
2. press Run (or `Ctrl/Cmd+Enter` — now IME-safe so the shortcut never fires mid-conversion),
3. read the result as a proper scrollable table with typed cells: `null` rendered distinctly, numbers right-aligned, strings as-is, `{$blob: ...}` envelopes shown as a `<blob: N chars>` placeholder rather than raw JSON.

## What this is — and what it isn't

**Is:**

- A new auto-imported component `apps/web/app/components/ResultGrid.vue` that takes a `QueryResult` prop and renders it through a virtualised row list (`@tanstack/vue-virtual`).
- A new pure formatter `apps/web/app/utils/format-value.ts` that maps `Value` → `{ kind, text }` so the grid can apply per-kind CSS without re-deriving the type at the template level.
- An IME composition guard added to `onEditorKeydown` in `apps/web/app/pages/connections/[id]/sql.vue`: `if (event.isComposing || event.keyCode === 229) return;` before the existing `Ctrl/Cmd+Enter` dispatch. (The `keyCode === 229` branch catches the legacy Safari/Android-WebView case where `isComposing` is not yet set on the `keydown`; both are well-documented MDN escape hatches.)
- A small reshuffle of `sql.vue`: keep the one-line summary as a caption _above_ the grid (it's still useful info), drop the JSON `result-preview` block, mount `<ResultGrid :result="result" />` when `result !== null`. `result-empty` copy stays.
- New dev dependency: `@tanstack/vue-virtual@^3.13` (latest is `3.13.28` as of opening). One transitive: `@tanstack/virtual-core`. No install scripts; no `pnpm-workspace.yaml` `allowBuilds` change required.
- One new `sql.result.row-count` i18n key for the caption shown above the grid (e.g. `"Showing {rows} rows."`), wired across all 11 locales. The existing `sql.result.summary` stays as-is and remains the source of truth for the columns × rows × affected line.

**Isn't:**

- A wire-contract change. `docs/api-contract.md` is untouched.
- A Monaco / CodeMirror upgrade. That can live in a follow-up polish ticket; this slice already adds a virtualisation library and one component, and stacking an editor swap would blow scope.
- Column virtualisation. Most SQL result sets in this app's target use-case have ≤ 30 columns; only **row** virtualisation is wired. If a future query routinely returns hundreds of columns, opening a follow-up ticket is cheaper than carrying the column-virtualiser plumbing speculatively.
- Sort / filter / column-resize / cell selection / copy-out. All of those are grid-as-product features; this slice ships grid-as-display.
- Value editing or in-place re-execution. Read-only render.
- Cell-level i18n for `null` / `<blob>`. Those are SQL/technical literals, not user-facing copy. Translating "NULL" is a category mistake.
- Capability gating. `GET /capabilities` integration is still deferred.

## Scope

1. **Add `@tanstack/vue-virtual` to `apps/web/package.json`** under `devDependencies` at `^3.13` (resolved to `3.13.28` at the time of writing). Single transitive: `@tanstack/virtual-core`. Confirm the install-script policy in `pnpm-workspace.yaml` does not need widening (it doesn't — the package ships pure JS).
2. **`apps/web/app/utils/format-value.ts`** _(new, pure)_ — `formatValue(v: Value): { kind: "null" | "number" | "string" | "blob"; text: string }`. Maps:
   - `null` → `{ kind: "null", text: "NULL" }`
   - `number` → `{ kind: "number", text: String(v) }`
   - `string` → `{ kind: "string", text: v }`
   - `{ $blob }` → `{ kind: "blob", text: \`<blob: ${$blob.length} chars>\` }`
   - The `Value` import comes from `useQueryExecution.ts`; the formatter must stay pure (no Vue, no i18n) so it can be unit-tested without `@nuxt/test-utils`.
3. **`apps/web/app/components/ResultGrid.vue`** _(new, auto-imported by Nuxt)_ — virtualised table.
   - Props: `{ result: QueryResult }` (required; the page renders the placeholder when `result === null` and only mounts the grid otherwise).
   - Setup: a `tableContainerRef = ref<HTMLDivElement | null>(null)`, `useVirtualizer(computed(() => ({ count: result.rows.length, getScrollElement: () => tableContainerRef.value, estimateSize: () => ROW_HEIGHT_PX, overscan: 8 })))`. `ROW_HEIGHT_PX = 36` (matches the 44 px touch baseline with comfortable line-height; cells are non-interactive so 36 px is fine — the editor and Run button still meet 44 px).
   - Template skeleton: `<div class="grid-scroll" ref="tableContainerRef">` outer scroller (`overflow: auto`, `max-height: clamp(240px, 60vh, 640px)`), inside a `<table class="grid">` with `<thead>` that renders column names from `result.columns`, and a virtualised `<tbody>` that uses the canonical `getTotalSize()` spacer + absolutely-positioned virtual rows pattern. Each `<td>` reads `formatValue(cell)` and applies a `cell--{kind}` class for CSS.
   - `[data-testid]`: `result-grid` on the outer wrapper, `result-grid__column-header` on every `<th>`, `result-grid__row` on every rendered `<tr>` in `<tbody>`, `result-grid__cell` on every `<td>`, and a `result-grid__cell--null` / `--blob` modifier class so tests can pin the kind without parsing text.
   - Mobile: `min-width: max-content` on the inner `<table>` keeps cells from wrapping; the outer container's `overflow-x: auto` turns it into a horizontal-scroll surface on 375 px.
4. **`apps/web/app/pages/connections/[id]/sql.vue`** _(modified)_ —
   - Add the IME guard at the top of `onEditorKeydown`:
     ```ts
     if (event.isComposing || event.keyCode === 229) return;
     ```
   - Replace the `<template v-else>` block (`result-summary` paragraph + optional `result-preview` `<pre>`) with the summary paragraph above the grid plus `<ResultGrid :result="result" />` below it. Keep `result-empty` copy unchanged.
   - Add a separate `<p data-testid="result-row-count">` (or fold into the existing summary) using the new `sql.result.row-count` key — this gives the user an at-a-glance row count when the table is scrolled past row 1.
5. **`apps/web/i18n/locales/*.json`** _(modified)_ — extend the existing `sql.result.*` block with one new key in all 11 locales:
   ```jsonc
   "sql": {
     "result": {
       "row-count": "Showing {rows} rows."
     }
   }
   ```
   Drop the now-unused `sql.result.preview-heading` key from all 11 locales (the `<pre>` preview goes away). Update `tests/i18n-locale-parity.test.ts` to add the new pin and remove the dropped one in the same commit so parity is never half-baked.
6. **Tests.**
   - `apps/web/tests/format-value.test.ts` _(new)_ — pure unit: `null` / number (positive, negative, zero, NaN — note `String(NaN) === "NaN"`) / string (empty, multi-byte) / `{ $blob: "" }` and `{ $blob: "AAAA" }`. Covers all four `kind` branches.
   - `apps/web/tests/result-grid.test.ts` _(new)_ — mount `ResultGrid` with a small `QueryResult` fixture; assert: column headers render in order, row count matches `rows.length` (with overscan tolerance — see § Test patterns), cell kinds carry their `cell--{kind}` modifier class, blob cells render the `<blob: N chars>` placeholder, and `tableContainerRef`'s outer `<div>` has `overflow: auto` so horizontal scroll works at narrow widths. Stub `getBoundingClientRect` on the scroll container so the virtualiser produces at least one visible row under happy-dom (see § Test patterns).
   - `apps/web/tests/sql-page.test.ts` _(modified)_ — adapt the existing slice-2 tests:
     - The `result-preview` JSON `<pre>` assertions are removed.
     - Add an IME guard test: dispatch `Ctrl+Enter` on the textarea with `isComposing: true` and assert `run` is **not** called. Add a second test with `keyCode: 229` for the legacy path.
     - Replace the JSON-preview test with a presence assertion: when `result.rows.length > 0`, the rendered output contains a `result-grid` testid. The grid's own assertions stay in `result-grid.test.ts`.

## Out of scope

- **Monaco / CodeMirror editor.** Separate polish ticket.
- **Column virtualisation, sort, filter, resize.** Future grid tickets.
- **Cell-level localisation** for `NULL` / `<blob>` placeholders. They are SQL/technical literals.
- **Copy-cell / select-cell / export-grid actions.** Future grid tickets.
- **Schema-aware cell rendering** (e.g. pretty-printing `jsonb`, formatting `date` per locale). Future ticket; for now the wire shape determines the kind.
- **Saved queries, query history viewer.** Phase 4 slice 4-and-beyond.

## Tasks

- [ ] Draft this issue and link from `.claude/project-status.md` "Ready to start".
- [ ] Add `@tanstack/vue-virtual` to `apps/web/package.json` devDependencies; run `pnpm install`; verify lockfile delta is just the new dep + `virtual-core` transitive.
- [ ] Write the failing `format-value` unit test (RED).
- [ ] Write the failing `result-grid` component test (RED).
- [ ] Update `sql-page.test.ts` for the IME-guard and grid-presence assertions (RED).
- [ ] Implement `app/utils/format-value.ts` (GREEN).
- [ ] Implement `app/components/ResultGrid.vue` (GREEN).
- [ ] Wire the new component + IME guard into `app/pages/connections/[id]/sql.vue` (GREEN); drop the `result-preview` block.
- [ ] Extend all 11 locale JSONs with `sql.result.row-count`; remove the dropped `sql.result.preview-heading`; re-pin `i18n-locale-parity.test.ts` accordingly.
- [ ] Update `.claude/project-status.md` (move 0013 Ready → In-progress) and `.claude/roadmap.md` (mark slice 3 DoD lines for result grid + virtualisation + IME).
- [ ] Verification chain: `pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`.

## Definition of Done

- [ ] `/connections/:id/sql` shows a virtualised `<table>` of the `QueryResult` rows after Run.
- [ ] `null` cells render with a distinct style; numeric cells right-align; `{$blob}` cells render `<blob: N chars>` rather than raw JSON.
- [ ] `Ctrl/Cmd+Enter` during IME composition does **not** trigger `run` — confirmed by tests that pass `isComposing: true` and by tests that pass the legacy `keyCode: 229`.
- [ ] Grid is horizontally scrollable at 375 px viewport; cells do not wrap.
- [ ] All 11 locale files carry the new `sql.result.row-count` key; the dropped `sql.result.preview-heading` is gone from all 11; parity test green.
- [ ] No regression on slice 2 surface: Run button, error banner, summary, route id wiring, focus-scoped shortcut behaviour still pass their existing assertions.
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] No file under `apps/api/`, `docs/api-contract.md`, or `docs/decisions.md` is touched. (Web-only slice.)
- [ ] `.claude/project-status.md` + `.claude/roadmap.md` updated in the same series of commits.

## Test patterns

`@tanstack/vue-virtual` reads `getBoundingClientRect()` on the scroll element to compute which virtual items are in range. happy-dom returns `{ width: 0, height: 0, ... }` by default, which makes the virtualiser yield zero virtual items and skips the entire rendered-row branch. The test-side workaround used in this slice:

```ts
// Before mounting, stub the rect on the scroll element after it's wired:
const container = wrapper.find<HTMLDivElement>('[data-testid="result-grid"]').element;
container.getBoundingClientRect = () =>
  ({
    width: 800,
    height: 480,
    top: 0,
    left: 0,
    right: 800,
    bottom: 480,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  }) as DOMRect;
// then trigger a measure (`virtualizer.value.measure()` via the public ref, or a `nextTick()` after a small scroll dispatch).
```

The `result-grid.test.ts` uses this pattern to assert that at least the first batch of virtual rows renders. Asserting "exactly N rows" is fragile under overscan; the test asserts a **range** (`rows.length >= 1 && rows.length <= fixture.rows.length + 8`) and pins the **content** of the first row to make it meaningful.

The IME-guard test relies on `@vue/test-utils` `trigger('keydown', { key: 'Enter', ctrlKey: true, isComposing: true })`. `KeyboardEvent` does carry `isComposing` in happy-dom even though typing into a real IME doesn't dispatch from inside it — the guard reads the field that was unmodelable as a _runtime_ concept but is _trivially modelable_ as an event payload. The legacy `keyCode: 229` branch is exercised the same way.

## References

- Slice 2 precedent: [`0012`](./0012-frontend-sql-editor.md).
- Slice 1 precedent: [`0011`](./0011-frontend-connection-list.md).
- Mobile DoD baseline: [`0006`](./0006-pwa-shell.md).
- i18n baseline: [`0008`](./0008-i18n-stage-1.md), `apps/web/tests/i18n-locale-parity.test.ts`.
- HTTP surface this slice consumes (still): `apps/api/src/usecase/execute-query.use-case.ts` (`QueryResult` shape), `docs/api-contract.md` § `QueryResult`.
- Library: [`@tanstack/vue-virtual`](https://tanstack.com/virtual/latest/docs/framework/vue/vue-virtual) — `useVirtualizer(computed(() => ({ count, getScrollElement, estimateSize, overscan })))` returns a `ref<Virtualizer>` exposing `.getVirtualItems()` and `.getTotalSize()`. Confirmed against `TanStack/table` canonical example.
- Phase plan: `.claude/roadmap.md` § Phase 4.
