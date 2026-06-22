# 0017 — Frontend schema browser tree view (Phase 5 slice 2)

- **Status:** closed (landed on `develop` 2026-06-22)
- **Phase:** Phase 5 (frontend) — second slice
- **Opened:** 2026-06-22
- **Closed:** 2026-06-22
- **Branch:** none (direct-to-`develop`, per the Phase 4 / Phase 5 slice 1 pattern)
- **Depends on:** [`0003`](./0003-nestjs-http-surface.md) (per-connection routing + `ExecuteQuery` adapter resolution), [`0004`](./0004-postgres-adapter.md) (the only adapter that returns schema-qualified `TableInfo` records today), [`0012`](./0012-frontend-sql-editor.md) (the SQL editor page this panel grafts onto), [`0015`](./0015-frontend-history-sidebar.md) (the sibling sidebar that establishes the stacked-panel sidebar pattern this slice reuses). Phase 1.5 mobile DoD ([`0006`](./0006-pwa-shell.md)) and Phase 2.5 i18n ([`0008`](./0008-i18n-stage-1.md)) carry over verbatim.
- **Blocks:** none — last remaining Phase 5 UI slice. The Phase 5 closeout brief back to desktop fires once the export round-trip cross-check against an actual `history.jsonl` fixture also passes (separate ticket).

## Goal

Surface the connection's live schema as a **tree panel on the SQL editor page** scoped to the current connection, with a one-click **insert-into-editor** for table and column identifiers.

After this slice, a user on `/connections/:id/sql` can:

1. see every table the live connection exposes — grouped by schema (Postgres `public`, `auth`, etc.; SQLite/D1 collapse under a single virtual "default" group),
2. expand a table to see its columns + declared types, lazy-loaded on first expand,
3. click a table or column name to insert its quoted identifier at the editor's cursor — no auto-run, no SQL rewrite,
4. trigger a manual refresh to re-read tables after a DDL change.

The schema panel runs against a new connection-scoped tables endpoint plus the existing `POST /connections/:id/query` for column introspection (a zero-row probe). No change to `docs/api-contract.md` — the connection-less `GET /tables` already documented stays, and the new `GET /connections/:id/tables` is a web-only extension parallel to `POST /connections/:id/query`.

## What this is — and what it isn't

**Is:**

- A new connection-scoped backend route `GET /connections/:id/tables` mirroring `POST /connections/:id/query`'s adapter-resolution pattern (registry lookup; unknown id → `CapabilityError` → 404 capability envelope). The contract-less `GET /tables` is left in place for the desktop-parity surface and the existing conformance tests; the new route exists because the web app's adapters are per-connection, not bound at startup.
- A new use case `ListConnectionTables` in `apps/api/src/usecase/` that takes the same `(defaultAdapter, registry)` pair as `ExecuteQuery` and resolves the adapter the same way. `connectionId` undefined would fall back to the default adapter, but the only caller — the new route — always supplies one; the unscoped `/tables` still goes through `ListTables` against `DATABASE_ADAPTER`, untouched.
- A new auto-imported composable `apps/web/app/composables/useSchemaBrowser.ts` exposing `tables` / `state` / `lastError` / `refresh()` / `loadColumns(schema, table)`. Mirrors the readonly-ref + `apiBase` shape of `useConnections` / `useQueryHistory`. `loadColumns` POSTs `SELECT * FROM <quoted> LIMIT 0` to `/connections/:id/query` and reads `QueryResult.columns`, returning `ReadonlyArray<{ name: string; declared_type: string | null }>`. Identifier quoting is a small pure helper local to the composable: defaults to PostgreSQL-style `"name"` with `"` doubled per the SQL standard, schema prefix dropped when null.
- A new auto-imported component `apps/web/app/components/SchemaBrowser.vue` — collapsible tree (`<details>` / `<summary>` for schemas and tables, no third-party widget). Props: `{ connectionId: string; apiBase?: string }`. Emits: `insert: (identifier: string) => void`. Identifier emitted on table click is the quoted `"schema"."table"` (or `"table"` if schema is null); on column click, the quoted `"column"` alone (the surrounding `SELECT … FROM …` is the user's job). 44 × 44 px touch targets on the refresh button and the insert buttons.
- A small reshuffle of `apps/web/app/pages/connections/[id]/sql.vue`: mount `<SchemaBrowser :connection-id="connectionId" @insert="onInsertIdentifier" />` **above** the existing `<HistorySidebar />` in the same sidebar column (per the user's slice 2 layout pick). `onInsertIdentifier(text)` writes at the textarea's `selectionStart..selectionEnd`, restores the caret to the end of the inserted text, and re-focuses the editor. Unlike replay, this is additive — current SQL is preserved.
- New i18n keys under a new `schema.*` namespace (`schema.heading`, `schema.refresh`, `schema.empty`, `schema.default-schema`, `schema.columns.loading`, `schema.error.load`, `schema.error.columns`, `schema.insert-table`, `schema.insert-column`) — wired across all 11 locale bundles.

**Isn't:**

- A contract change. `docs/api-contract.md` is untouched. The new `GET /connections/:id/tables` is a web-only extension parallel to the existing web-only `/connections/*` surface (registration, listing, deletion, scoped query), all of which were already documented in `apps/api/README.md` rather than the desktop-parity contract.
- A new `/columns` endpoint. Column metadata comes from `QueryResult.columns` on a `LIMIT 0` probe — works against any adapter that conforms to the contract, costs no new surface to maintain, and avoids a duplicate column-introspection use case per dialect.
- A new "default-empty" sentinel for adapters that return all-null schemas. NullAdapter still returns `[]`; SQLite/D1 (when they land) leave `schema: null` per the contract — the UI groups everything under a single virtual schema (i18n key `schema.default-schema`) and never invents a name.
- Auto-refresh / polling. The panel refreshes (a) once on mount and (b) when the user presses the refresh button. No background timer, no after-Run refresh (DDL is rare and a manual refresh is a one-tap action).
- Editor rewrites. Insert appends the identifier at the caret; the user assembles the surrounding `SELECT`. Anything smarter (auto-`FROM` insertion, `JOIN` planner, etc.) is a follow-up that needs a real SQL parser.
- Live tab-state. The schema panel and history sidebar are stacked, not tabbed. No state machine to track which panel is open; both render side-by-side at desktop widths.
- A schema search box. Defer until a real connection ships with > 200 tables — the in-place tree handles dozens-to-low-hundreds fine. The follow-up will share the same `useSchemaBrowser.tables` state.
- Capability gating. The schema panel mounts unconditionally; if `loadColumns` fails because the adapter does not implement `executeQuery` (e.g. NullAdapter), the column-level error banner explains it. No `GET /capabilities` integration in this slice.

## Scope

1. **`apps/api/src/usecase/list-connection-tables.use-case.ts`** _(new)_ —

   ```ts
   export class ListConnectionTables {
     constructor(
       private readonly defaultAdapter: DatabaseAdapter,
       private readonly registry: ConnectionRegistry,
     ) {}

     async execute(connectionId?: string): Promise<ListConnectionTablesOutput> {
       return { tables: await this.resolveAdapter(connectionId).listTables() };
     }

     private resolveAdapter(connectionId: string | undefined): DatabaseAdapter {
       if (connectionId === undefined) return this.defaultAdapter;
       const record = this.registry.get(connectionId);
       if (!record) {
         throw new CapabilityError(`unknown connection: ${connectionId}`);
       }
       return record.adapter;
     }
   }
   ```

   Mirrors `ExecuteQuery.resolveAdapter` so the 404 envelope is consistent. The unknown-id branch keeps the existing `ContractErrorFilter` happy.

2. **`apps/api/src/presentation/connection-tables.controller.ts`** _(new)_ —

   ```ts
   @Controller("connections")
   export class ConnectionTablesController {
     constructor(private readonly listConnectionTables: ListConnectionTables) {}

     @Get(":id/tables")
     listOn(@Param("id") id: string): Promise<ListConnectionTablesOutput> {
       return this.listConnectionTables.execute(id);
     }
   }
   ```

   Separate controller (not folded into the existing `TablesController` or `ConnectionsController`) so the file boundaries match the use case boundary — `TablesController` keeps owning the connection-less `/tables`, `ConnectionsController` keeps owning registration/listing/deletion, this new controller owns the per-connection schema surface.

3. **`apps/api/src/app.module.ts`** _(modified)_ — register the new controller in `controllers` and the new use case in `providers` with a `useFactory` injecting `DATABASE_ADAPTER` + `CONNECTION_REGISTRY`, mirroring the `ExecuteQuery` factory entry.
4. **`apps/web/app/composables/useSchemaBrowser.ts`** _(new, auto-imported)_ — same shape as `useQueryHistory`:
   - `useSchemaBrowser(connectionId, options?: { apiBase?: string })` returns `{ tables, state, lastError, refresh, loadColumns }`.
   - `tables: Readonly<Ref<ReadonlyArray<{ schema: string | null; name: string }>>>` (= the API's `TableInfo[]` projection — the type is duplicated as a `type` locally since the web app does not import from `apps/api/`).
   - `refresh()` GETs `${apiBase}/connections/${connectionId}/tables`, expects `{ tables: TableInfo[] }`, stores it.
   - `loadColumns(schema: string | null, table: string)`: POSTs `{ sql: "SELECT * FROM " + qualify(schema, table) + " LIMIT 0" }` to `${apiBase}/connections/${connectionId}/query`, returns the `result.columns` array. `qualify` produces `"schema"."table"` (or `"table"` when `schema` is null) with `"` doubled per SQL standard.
   - `lastError: Readonly<Ref<CategorisedError | null>>` reuses the shared `internal/i18n-error.ts` bridge so error categories surface in the same `error.prefix.*` namespace as the rest of the app.
   - `onMounted` calls `refresh()` once (mirrors `useConnections` / `useQueryHistory`).
5. **`apps/web/app/components/SchemaBrowser.vue`** _(new, auto-imported)_ —
   - Props: `{ connectionId: string; apiBase?: string }`.
   - Emits: `insert: (identifier: string) => void`.
   - Template: an `<aside data-testid="schema-browser">` containing a header (`<h3>{{ t("schema.heading") }}</h3>` + `<button data-testid="schema-refresh">{{ t("schema.refresh") }}</button>`), a global error banner when `lastError` is set, an empty-state paragraph when `tables.length === 0`, and a list of `<details data-testid="schema-group">` — one per schema. Inside each schema, a list of `<details data-testid="schema-table">` — one per table. Table summary shows the table name and an `<button data-testid="schema-insert-table">` that emits `insert(qualified)`. On first table expand, fire `loadColumns(schema, table)` and store the result in a per-table cache keyed by `"${schema ?? ''}.${table}"`. Column rows render under the table with their `name`, `declared_type`, and a `<button data-testid="schema-insert-column">` that emits `insert(quoted column name)`.
   - The two virtual-schema cases (`null` and `""`) both map to `t("schema.default-schema")`. Tables with the same schema null are folded into one virtual group.
   - Mobile: `min-height: 44px; min-width: 44px` on the refresh + insert buttons; `<details>` summaries naturally stack vertically.
6. **`apps/web/app/pages/connections/[id]/sql.vue`** _(modified)_ —
   - Import `SchemaBrowser`.
   - Add `editorRef = ref<HTMLTextAreaElement | null>(null)` and bind to the existing `<textarea>` (`ref="editorRef"`).
   - Add `onInsertIdentifier(text: string)` that splices `text` into `sqlInput.value` at the textarea's `selectionStart..selectionEnd`, updates the model value, and on `nextTick` restores caret to `start + text.length` and re-focuses the editor.
   - Mount `<SchemaBrowser :connection-id="connectionId" @insert="onInsertIdentifier" />` **above** `<HistorySidebar … />` in the existing `.history-column` container. Rename the wrapper to `.sidebar-column` so the name reflects that it now hosts two panels.
7. **`apps/web/i18n/locales/*.json`** _(modified)_ — add a new `schema.*` block to every locale:
   ```jsonc
   "schema": {
     "heading": "Schema",
     "refresh": "Refresh",
     "empty": "(no tables)",
     "default-schema": "(default)",
     "columns": { "loading": "Loading columns…" },
     "error": {
       "load": "Failed to load schema",
       "columns": "Failed to load columns"
     },
     "insert-table": "Insert table",
     "insert-column": "Insert column"
   }
   ```
   Re-pin `tests/i18n-locale-parity.test.ts` with the nine new leaf keys.
8. **Tests.**
   - `apps/api/src/usecase/list-connection-tables.use-case.spec.ts` _(new)_ — three cases mirroring `ExecuteQuery`:
     1. dispatches to the default adapter when no `connectionId` is supplied,
     2. dispatches to the registry-resolved adapter when a `connectionId` is supplied,
     3. raises `CapabilityError` for an unknown `connectionId` so the route 404s.
   - `apps/api/src/presentation/connection-tables.controller.spec.ts` _(new)_ — delegates to the use case and returns the contract `{ tables: [...] }` shape.
   - `apps/api/test/http-contract.spec.ts` _(modified)_ — three new cases:
     1. `GET /connections/:id/tables` returns the contract `{ tables: [] }` shape against the registered NullAdapter (no `executeQuery` involved, only `listTables`),
     2. `GET /connections/does-not-exist/tables` → 404 capability envelope matching `expect.stringContaining("unknown connection")`,
     3. `GET /connections/:id/tables` requires bearer auth when `API_SECRET` is set (paired with the existing `auth.integration.spec.ts` pattern so we know the new route is not accidentally outside the middleware).
   - `apps/web/tests/use-schema-browser.test.ts` _(new)_ — mock `apiFetch` to return `{ tables: [...] }`; assertions:
     - `refresh()` mount-time populates `tables` and leaves `state === "idle"`,
     - `refresh()` failure populates `lastError` with the categorised shape,
     - `loadColumns(schema, table)` issues a POST with `SELECT * FROM "schema"."table" LIMIT 0` and returns the `result.columns`,
     - `loadColumns(null, table)` issues `SELECT * FROM "table" LIMIT 0`,
     - identifiers containing a literal `"` are escaped by doubling.
   - `apps/web/tests/schema-browser.test.ts` _(new)_ — mount the component with the `apiFetch` mock; assertions:
     - empty state renders when `/tables` returns `{ tables: [] }`,
     - tables grouped by schema (a `"public"` table + a null-schema table render under two distinct `<details>` headers, the null one labelled with the `schema.default-schema` key),
     - clicking a table's insert button emits `insert` with the quoted `"schema"."table"`,
     - first expansion of a table calls `apiFetch` a second time (the `LIMIT 0` probe) and renders the column rows; second expansion does **not** re-fetch (cache hit),
     - clicking a column's insert button emits `insert` with the quoted column name (no schema/table prefix),
     - refresh button calls `apiFetch` again,
     - error banner shows when `/tables` fetch fails; column-level error banner shows when `LIMIT 0` fails.
   - `apps/web/tests/sql-page.test.ts` _(modified)_ — adapt the existing slice 4 tests:
     - Assert the schema browser mounts on the page (presence of `schema-browser` testid),
     - Add a test that emits `insert` from a stubbed schema browser and asserts the textarea value updates with the identifier spliced in at the caret position (start with `"FROM " | cursor`, emit `"public"."users"`, expect `"FROM \"public\".\"users\""` and caret at end of inserted text).
   - `apps/web/tests/i18n-locale-parity.test.ts` _(modified)_ — pin the nine new `schema.*` keys.

## Out of scope

- **Schema search.** Tree-only for slice 2; defer search until a real connection ships >200 tables.
- **Auto-refresh on a timer.** Refresh fires on mount and on the user's button press.
- **A `/columns` endpoint.** `LIMIT 0` covers the case for every adapter that conforms to the contract.
- **Drag-and-drop into the editor.** Click-to-insert is the slice 2 surface; drag-and-drop is a follow-up.
- **DDL operations (create / drop / alter).** Read-only browser. DDL is a separate dialect-aware ticket.
- **Tab UI** in the sidebar (Schema | History). Stacked panels per the user's slice 2 layout pick.
- **Index / constraint / view metadata.** Tables + columns only; the desktop has not shipped this either.

## Tasks

- [ ] Draft this issue and add a pointer from `.claude/project-status.md` "Ready to start".
- [ ] Write the failing `ListConnectionTables` use case spec (RED).
- [ ] Write the failing `ConnectionTablesController` spec (RED).
- [ ] Extend `apps/api/test/http-contract.spec.ts` for the three new cases (RED).
- [ ] Write the failing `useSchemaBrowser` composable test (RED).
- [ ] Write the failing `SchemaBrowser` component test (RED).
- [ ] Update `sql-page.test.ts` for the schema-mount + insert-at-caret assertions (RED).
- [ ] Update `i18n-locale-parity.test.ts` pins for the nine new schema keys (RED).
- [ ] Implement `usecase/list-connection-tables.use-case.ts` + `presentation/connection-tables.controller.ts` (GREEN).
- [ ] Wire the new use case + controller into `app.module.ts` (GREEN).
- [ ] Implement `composables/useSchemaBrowser.ts` (GREEN).
- [ ] Implement `components/SchemaBrowser.vue` (GREEN).
- [ ] Mount the schema browser above the history sidebar in `pages/connections/[id]/sql.vue` (GREEN); add `onInsertIdentifier` with splice-at-caret.
- [ ] Extend all 11 locale JSONs with the new `schema.*` keys.
- [ ] Update `.claude/project-status.md` (Phase 5 slice 2 landed) and `.claude/roadmap.md` (tick the slice 2 DoD line).
- [ ] Verification chain: `pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`.

## Definition of Done

- [ ] `/connections/:id/sql` shows a `schema-browser` aside above the existing history sidebar.
- [ ] Tables grouped by schema; null/empty schemas roll up under a single virtual "default" group labelled by `schema.default-schema`.
- [ ] Expanding a table for the first time lazy-loads its columns via `LIMIT 0`; the second expand does not re-fetch.
- [ ] Clicking a table insert button inserts the quoted `"schema"."table"` (or `"table"`) at the editor caret; clicking a column insert button inserts the quoted column name. Caret lands at the end of the inserted text; the editor regains focus.
- [ ] `GET /connections/:id/tables` returns the contract `{ tables: TableInfo[] }` shape; unknown id → 404 capability envelope; auth-gated when `API_SECRET` is set.
- [ ] Schema-load error and column-load error each render an in-place banner; the rest of the panel stays interactive.
- [ ] At 375 px the schema browser stacks naturally inside the sidebar column above the history; at ≥ 768 px the sidebar column sits to the right of the editor (slice 1 layout preserved). Refresh + insert buttons meet 44 × 44 px.
- [ ] All 11 locale files carry the nine new `schema.*` keys; parity test green.
- [ ] No regression on Phase 4 / Phase 5 slice 1 surfaces: connection list, SQL editor, result grid, IME guard, history sidebar, error banner still pass their existing assertions.
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] `docs/api-contract.md` and `docs/decisions.md` are untouched. (Web-only extension parallel to the existing `/connections/*` surface.)
- [ ] `.claude/project-status.md` + `.claude/roadmap.md` updated in the same series of commits.

## Test patterns

Backend specs follow the existing `execute-query.use-case.spec.ts` shape — a small `adapter()` factory and a `registry()` factory build the dependencies, and the three branch tests assert `defaultAdapter` vs registry-resolved vs `CapabilityError`. `ConnectionTablesController` follows `tables.controller.spec.ts` — one delegation test.

Frontend specs follow `use-query-history.test.ts` and `history-sidebar.test.ts` — mock the shared `apiFetch` indirection so the composable / component never touch the network. The component test asserts on `data-testid` selectors and stubs `vue-i18n` so the translation key surfaces as the literal `t("schema.…")` string.

The `sql-page.test.ts` insert-at-caret case mounts the page with a `SchemaBrowserStub` registered via `global.stubs` so the page-level assertion is decoupled from the schema browser's mount-time fetch. The stub exposes a method to trigger the `insert` event, the test asserts the textarea's `.element.value` after the splice.

The auth-gated http-contract assertion uses the existing pattern from `auth.integration.spec.ts`: `createApp({ apiSecret: "test-secret" })`, then issue a `GET /connections/<id>/tables` without `Authorization` and assert 401 / with `Authorization: Bearer test-secret` and assert 200.

## References

- Per-connection routing precedent: `apps/api/src/presentation/query.controller.ts`, `apps/api/src/usecase/execute-query.use-case.ts`.
- Default-adapter `/tables` precedent: `apps/api/src/presentation/tables.controller.ts`, `apps/api/src/usecase/list-tables.use-case.ts`.
- Composable + sidebar conventions: `apps/web/app/composables/useQueryHistory.ts`, `apps/web/app/components/HistorySidebar.vue` (slice 1).
- Page-layout precedent: `apps/web/app/pages/connections/[id]/sql.vue` (slice 1 sidebar column).
- HTTP contract: `docs/api-contract.md` — `TableInfo` shape, `QueryResult.columns` shape, `capability` 404 envelope.
- Auth integration test pattern: `apps/api/test/auth.integration.spec.ts`.
- Mobile DoD baseline: [`0006`](./0006-pwa-shell.md).
- i18n baseline: [`0008`](./0008-i18n-stage-1.md), `apps/web/tests/i18n-locale-parity.test.ts`.
- Phase plan: `.claude/roadmap.md` § Phase 5.
