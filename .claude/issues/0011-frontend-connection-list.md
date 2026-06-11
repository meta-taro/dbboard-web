# 0011 — Frontend connection list (Phase 4 slice 1)

- **Status:** open
- **Phase:** Phase 4 (frontend) — first slice
- **Opened:** 2026-06-11
- **Closed:** —
- **Suggested branch:** `feature/0011-frontend-connection-list`
- **Depends on:** [`0003`](./0003-nestjs-http-surface.md) (HTTP surface — `POST/GET/DELETE /connections`) and [`0004`](./0004-postgres-adapter.md) (Postgres driver so the registered connection is something a user can actually pick later). Phase 1.5 mobile DoD ([`0006`](./0006-pwa-shell.md)) and Phase 2.5 i18n ([`0008`](./0008-i18n-stage-1.md)) carry over verbatim.
- **Blocks:** Phase 4 slice 2 (SQL editor) and slice 3 (results grid) — both need a registered connection to target.

## Goal

Land the first user-facing Phase 4 surface: a **connection list page** that lets a user

1. see the connections already registered with the backend (`GET /connections`),
2. register a new one with a label + driver + connection config (`POST /connections`),
3. delete one they no longer want (`DELETE /connections/:id`).

That is the entire slice. No SQL editor, no table sidebar, no result grid — those land in the next two slices once a registered connection exists in the UI for them to target.

## What this is — and what it isn't

**Is:**

- A Nuxt page at `/connections` that reads + mutates the `/connections` HTTP surface already implemented in `apps/api` (see [`0003`](./0003-nestjs-http-surface.md), extended by [`0004`](./0004-postgres-adapter.md)).
- A `useConnections()` composable that owns `$fetch` against `runtimeConfig.public.apiBaseUrl` and exposes a reactive list + `register()` + `remove()`.
- Mobile-first layout following the Phase 1.5 DoD (375 × 667 viewport baseline, 44 × 44 touch targets, iOS safe-area insets honoured by `app.vue`'s `padding: env(safe-area-inset-*)`).
- i18n through the 11 locale files (`apps/web/i18n/locales/*.json`) under a new `connections.*` key namespace, parity-tested by the existing `i18n-locale-parity.test.ts`.

**Isn't:**

- A wire-contract change. `apps/web` consumes the existing JSON surface; `docs/api-contract.md` is untouched. (The `/connections` surface itself is web-only — the desktop client is single-connection — so this ticket does not extend the cross-repo contract.)
- A secret-handling change. Passwords / connection strings are POSTed and then forgotten by the UI; the backend already drops them from `GET /connections` (see `apps/api/src/usecase/list-connections.use-case.ts`).
- A driver picker beyond what the backend currently supports. Today that is `"postgres"` (real) and `"null"` (test fallback). The form ships a `<select>` populated from a literal client-side constant — registry of drivers is a separate concern.
- A query-history UI. Phase 4 slice 4 (TBD) will consume `GET /history/export.jsonl`.

## Scope

1. **`apps/web/app/composables/useConnections.ts`** — owns the API I/O.
   - `list: Ref<ReadonlyArray<ConnectionView>>` — populated on mount via `GET /connections`.
   - `register(input: RegisterInput): Promise<void>` — `POST /connections`, then refreshes `list` from the server (do not push the local optimistic shape — the server-assigned `id` is the source of truth).
   - `remove(id: string): Promise<void>` — `DELETE /connections/:id` (expects `204`), then refreshes `list`.
   - `state: Ref<"idle" | "loading" | "error">` and `lastError: Ref<string | null>` — surfaces the categorised error envelope from `ContractErrorFilter` (`error.category` + `error.message`) so the page can show the right `error.prefix.*` translation.
2. **`apps/web/app/pages/connections.vue`** — the page UI.
   - Lists existing connections (`label`, `driver`, monospace `id`, delete button per row).
   - Inline add form: `label`, `driver` (`<select>` of `postgres` / `null`), then a `connectionString` text input. Other Postgres fields (`host` / `port` / `database` / `user` / `password`) are out of scope for slice 1 — `connectionString` already covers Neon, Supabase, Aurora DSQL, and local Postgres. A follow-up slice can add the discrete fields.
   - Empty state ("no connections registered yet") routed through i18n.
   - Touch targets ≥ 44 × 44; inputs full width on 375 px; row layout switches to two-column on `@media (min-width: 768px)`.
3. **`apps/web/app/pages/index.vue`** — replace the Phase-1 scaffold paragraph with a link to `/connections` (and keep the API base URL caption as a debug aid).
4. **`apps/web/i18n/locales/*.json`** — new top-level `connections.*` keys translated for all 11 locales; existing `error.prefix.*` re-used as-is.
5. **Tests.**
   - `apps/web/tests/useConnections.test.ts` — mock `$fetch` (Nuxt's global). Cover: initial load populates `list`; `register` POSTs the body and refreshes; `remove` DELETEs and refreshes; backend error envelope ends up on `lastError` + `state === "error"`.
   - `apps/web/tests/connections-page.test.ts` — mount the page with `@vue/test-utils`, assert the list renders, the add form submits, the empty-state copy appears when the list is empty, and the i18n keys resolve via the existing test harness.

## Out of scope

- **SQL editor / runner.** Phase 4 slice 2.
- **Result grid.** Phase 4 slice 3.
- **History viewer.** Phase 4 slice 4 (consumes `GET /history/export.jsonl`).
- **Driver-specific form fields** (Postgres `host` / `port` / `database` / `user` / `password` separately, Supabase project URL, DSQL IAM token). `connectionString` covers every backend the API currently accepts; the split form is a follow-up.
- **Auth.** The backend still emits `actor: null`; the UI does not gate the page behind a login.
- **Capability-driven UI dimming.** `GET /capabilities` is per-connection and only matters once a connection is selected for query — slice 2's concern.

## Tasks

- [ ] Draft this issue and link it from `.claude/project-status.md` "Ready to start".
- [ ] Write failing tests in `apps/web/tests/useConnections.test.ts` and `apps/web/tests/connections-page.test.ts` (RED).
- [ ] Implement `apps/web/app/composables/useConnections.ts` to make the composable test pass (GREEN).
- [ ] Implement `apps/web/app/pages/connections.vue` to make the page test pass (GREEN).
- [ ] Update `apps/web/app/pages/index.vue` to point at the new page.
- [ ] Add `connections.*` keys to all 11 locale JSON files; verify `i18n-locale-parity.test.ts` still passes.
- [ ] Update `.claude/project-status.md` (move 0011 from Ready-to-start → In-progress → Completed) and `.claude/roadmap.md` (note slice 1 of Phase 4 landed).
- [ ] Verification chain: `pnpm format:check && pnpm -r typecheck && pnpm -r lint && pnpm -r test && pnpm -r build`.

## Definition of Done

- [ ] `/connections` page renders the live `GET /connections` list against a running `apps/api`.
- [ ] Registering a Postgres connection via the form results in a new row appearing in the list (server-assigned `id` shown).
- [ ] Deleting a row removes it from the list after the `204` returns.
- [ ] Backend error envelope (`ContractErrorFilter` shape: `{ error: { category, message } }`) surfaces in the UI through `error.prefix.<category>` + the raw message.
- [ ] All 11 locale files carry the new `connections.*` keys; parity test green.
- [ ] Touch targets ≥ 44 × 44 on every interactive element (delete button, add button, `<select>`, inputs).
- [ ] `pnpm format:check`, `pnpm -r typecheck`, `pnpm -r lint`, `pnpm -r test`, `pnpm -r build` all green.
- [ ] No file under `apps/api/`, `docs/api-contract.md`, or `docs/decisions.md` is touched. (Web-only slice.)
- [ ] `.claude/project-status.md` + `.claude/roadmap.md` updated in the same PR.

## References

- HTTP surface this slice consumes: `apps/api/src/presentation/connections.controller.ts` (`POST` / `GET` / `DELETE /connections`), `apps/api/src/usecase/list-connections.use-case.ts` (response shape), `apps/api/src/presentation/dto/register-connection.dto.ts` (request shape).
- Mobile DoD baseline: [`0006`](./0006-pwa-shell.md).
- i18n baseline: [`0008`](./0008-i18n-stage-1.md), `apps/web/tests/i18n-locale-parity.test.ts`.
- Phase plan: `.claude/roadmap.md` § Phase 4.
