# 0014 — Frontend mobile Playwright E2E (Phase 4 slice 4)

- **Status:** open
- **Phase:** Phase 4 (frontend) — fourth slice
- **Opened:** 2026-06-15
- **Closed:** —
- **Suggested branch:** `feature/0014-frontend-mobile-e2e`
- **Depends on:** [`0011`](./0011-frontend-connection-list.md) (the `/connections` page registers and lists connections), [`0012`](./0012-frontend-sql-editor.md) (the `/connections/:id/sql` page + `useQueryExecution()` POSTs the query), [`0013`](./0013-frontend-result-grid.md) (the `ResultGrid` + IME guard the E2E exercises). Phase 1.5 mobile DoD ([`0006`](./0006-pwa-shell.md)) carries over verbatim — the 375 × 667 viewport is still the baseline.
- **Blocks:** the four real-device acceptance items still listed under `0006` — once a Playwright mobile project consistently passes the critical path, the maintainer's manual real-device session has a smaller gap to cover.

## Goal

Close the Phase 4 frontend DoD with one Playwright E2E that drives a real Chromium (mobile + desktop viewports) through the critical user path that slices 1 → 3 wired up: **register a connection → open the SQL editor → run a query → see the virtualised grid render → confirm the IME composition guard prevents premature dispatch**.

This is the first Playwright suite in the repo. It needs to ship with the same care the rest of the test stack got: a separate config, a separate runner command, no Docker required, and explicitly out of the default `pnpm -r test` and pre-push paths so a Playwright-browser miss never blocks an unrelated commit.

## What this is — and what it isn't

**Is:**

- A new `@playwright/test` dev dependency in `apps/web`. Pinned to a stable minor known to be past `minimumReleaseAge: 1440` (24 h) so `pnpm install --frozen-lockfile` does not fail in a clean clone.
- A new `apps/web/playwright.config.ts` with two projects: `mobile` (Pixel 5 viewport, ~393 × 851) and `desktop` (default Chromium 1280 × 720). Mobile is the baseline that satisfies the Phase 4 DoD; desktop is included because the typical regression a maintainer wants to catch is "mobile-only breaks on desktop" or vice versa.
- A new `apps/web/e2e/` directory holding all specs. Vitest's `include` glob already only matches `app/**` and `tests/**`, so an `e2e/` peer is naturally excluded — no test-config widening.
- Three specs:
  - `e2e/connection-flow.spec.ts` — registers a connection, navigates via the `Run SQL` row link, runs `SELECT id, label FROM things;` against a mocked `POST /connections/:id/query`, asserts the result grid renders the expected column headers and at least one row of cells, and asserts the grid container is the horizontal-scroll surface (375 px width × 4 columns ≥ overflow). Plus a mobile-only assertion that all touch targets in the critical path are ≥ 44 × 44 px (`bounding_box` check on the Run button and the row's `Run SQL` link).
  - `e2e/ime-guard.spec.ts` — focuses the textarea, dispatches a synthetic `keydown` with `ctrlKey: true` and `isComposing: true`, then with `keyCode: 229`, and asserts the mocked `POST /connections/:id/query` was **not** called. Re-asserts the modern path (`Ctrl+Enter` without `isComposing`) still fires so the guard isn't a regression.
  - `e2e/result-grid-virtualisation.spec.ts` — mounts a 500-row result via the route mock and asserts that `document.querySelectorAll('[data-testid="result-grid__row"]').length` is dramatically smaller than 500 (signalling the virtualizer is engaged) and that scrolling to the bottom of `.grid-scroll` brings the last row into view.
- A new `pnpm e2e` script at the root, plus `e2e` and `e2e:install-browsers` scripts inside `apps/web/package.json`. The root script is a thin pass-through to `pnpm --filter @dbboard-web/web e2e`.
- API requests are **mocked at the browser layer via `page.route('**/connections/**', ...)`**, not against a running NestJS server. Reason: keeping the E2E hermetic (no Docker, no real DB, no port juggling) is more important than exercising the API again — the API has its own contract conformance battery in `apps/api/tests/conformance/`. The webServer that Playwright launches is the Nuxt app only.
- `playwright-report/`, `test-results/`, and `blob-report/` added to `.gitignore`.

**Isn't:**

- A real Postgres / libSQL run. The mocked route returns canned JSON. Real database E2E belongs in the conformance suite (which already covers wire-level shapes) — Playwright's job here is UI behaviour, not driver verification.
- A new CI workflow. CI integration is a follow-up — landing the test runner first means the next CI commit can wire it up without also adding Playwright. The pre-push hook stays `format` / `typecheck` / `lint` / `test` / `build` only.
- A full mobile gesture matrix. The grid uses native scroll on `.grid-scroll`; we don't simulate momentum, pinch zoom, or rotate.
- A capability-gated flow. `GET /capabilities` integration is still deferred to a later slice.
- An accessibility audit. axe-playwright integration is worth doing but it would push scope past one slice; opened as a follow-up below.
- A locale matrix. The default locale (`en`) is enough for slice 4. Per-locale visual regression belongs in its own slice.

## Why this scope

Three earlier slices built the surface area; slice 4 just exercises it from a real engine. The IME guard in particular cannot be validated under happy-dom (which doesn't model `compositionstart` / `compositionend` semantics) — Playwright on a real Chromium is the first place the legacy `keyCode === 229` path can be tested as it actually fires. Without that, slice 3's guard is unverified, which is exactly the kind of code that bit-rots into "works on the dev's machine."

The hermetic mock-the-API stance is deliberate. The conformance suite already proves the HTTP layer matches `docs/api-contract.md`. Re-validating it through Playwright wouldn't catch a class of bug the unit / conformance suites don't; it would just add Docker as a Playwright prerequisite. Net effect: the maintainer is more likely to actually run `pnpm e2e` because it doesn't ask for Docker.

The two-project (mobile + desktop) split mirrors the slice-3 DoD: every interactive control was sized for both. If a future PR breaks the desktop layout, the desktop project catches it; if it breaks the mobile, the mobile project catches it.

## Scope

1. **`apps/web/package.json`** _(updated)_ — add `@playwright/test` to `devDependencies` at a version known to be past 24 h (`^1.50.0` resolves to a current stable that's been out for weeks; pnpm picks the highest release-aged version, so the lockfile pins are deterministic). Add two scripts: `"e2e": "playwright test"` and `"e2e:install-browsers": "playwright install chromium --with-deps"`.
2. **`apps/web/playwright.config.ts`** _(new)_ — two projects (`mobile`, `desktop`), `testDir: ./e2e`, `webServer: { command: "pnpm dev", url: "http://localhost:3000", reuseExistingServer: !process.env.CI, timeout: 120_000 }`. `use: { baseURL: "http://localhost:3000" }`. Trace on first retry, screenshot on failure, video off (artifact cost). Workers default; one retry on CI, zero locally.
3. **`apps/web/e2e/connection-flow.spec.ts`** _(new)_ — registers a connection, navigates via `Run SQL`, runs a query, asserts grid render + mobile touch-target sizes.
4. **`apps/web/e2e/ime-guard.spec.ts`** _(new)_ — covers both the modern `isComposing` and legacy `keyCode === 229` paths, asserts the route mock was not called in either.
5. **`apps/web/e2e/result-grid-virtualisation.spec.ts`** _(new)_ — mounts 500 rows via the route mock, asserts row pool is much smaller than total, and last row appears after scrolling.
6. **`apps/web/e2e/fixtures.ts`** _(new)_ — shared fixture helpers: a `mockApi(page)` function that wires up `page.route()` for the three endpoints the suite touches (`GET /connections`, `POST /connections`, `POST /connections/:id/query`), plus a tiny request counter the IME spec asserts against.
7. **Root `package.json`** _(updated)_ — add `"e2e": "pnpm --filter @dbboard-web/web e2e"` for ergonomic invocation from the workspace root.
8. **`.gitignore`** _(updated)_ — append `playwright-report/`, `test-results/`, `blob-report/`, `apps/web/test-results/`, `apps/web/playwright-report/`, `apps/web/blob-report/`.
9. **`apps/web/eslint.config.*`** _(possibly updated)_ — ignore `e2e/` from the Nuxt-app lint scope (Playwright specs use a different runtime contract — `test` / `expect` from `@playwright/test`, not Vitest) OR add a small override block that enables `@playwright/test` globals for that directory. Decision deferred to implementation: whichever produces the cleaner diff.

## Definition of Done

- [ ] `pnpm install --frozen-lockfile` succeeds on a clean clone with `@playwright/test` resolved past the 24 h quarantine.
- [ ] `pnpm exec playwright install chromium` (or `pnpm --filter @dbboard-web/web e2e:install-browsers`) succeeds; this is a one-time-per-machine setup and is **documented** in the slice 4 docs commit so the maintainer knows it's expected.
- [ ] `pnpm e2e` from the root runs both Playwright projects (`mobile`, `desktop`) and all three specs pass.
- [ ] `pnpm -r test` still runs Vitest only — no Playwright spec leaks in.
- [ ] Pre-push hook is unchanged (still `format` / `typecheck` / `lint` / `test` / `build`). Playwright is opt-in.
- [ ] `connection-flow.spec.ts` passes on **both** the mobile and desktop projects.
- [ ] On the mobile project, the result-grid spec asserts the `.grid-scroll` container has overflow content (i.e. the table is wider than the viewport).
- [ ] The IME guard spec passes on **both** projects, and explicitly verifies the API mock recorded **zero** calls during the IME-composition keydown events.
- [ ] The virtualisation spec confirms `<= 30` `data-testid="result-grid__row"` nodes in the DOM when 500 rows are provided (typical overscan-aware bound on a Pixel 5 viewport at 36 px row height).
- [ ] All Playwright artefact directories are in `.gitignore` and the working tree is clean after a run.
- [ ] `.claude/project-status.md` and `.claude/roadmap.md` updated to record slice 4 status and tick the Phase 4 E2E DoD line.

## Follow-ups (explicit non-goals)

- **CI integration of `pnpm e2e`** — a separate ticket once the suite is stable.
- **axe-playwright a11y assertions** — a separate ticket; would touch the same files and is worth a dedicated review pass.
- **Visual regression / snapshot screenshots** — Playwright's `toHaveScreenshot` is great but locks the repo into per-platform baseline images, which is a maintenance choice the maintainer should weigh once the functional suite is stable.
- **Per-locale E2E** — the current suite runs against the default locale only; a future ticket can parameterise the projects by `?lang=` query.
- **Real-driver smoke E2E** — gated on testcontainers and reuses the `0004` Postgres setup; out of slice 4 scope.

## How this lands on the test pyramid

| Layer                           | Where                         | What it proves                                                                                                                                          |
| ------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit (Vitest + happy-dom)       | `apps/web/tests/*.test.ts`    | Composable + component contracts in isolation.                                                                                                          |
| HTTP contract / conformance     | `apps/api/tests/conformance/` | The web's NestJS surface matches `docs/api-contract.md` byte-for-byte.                                                                                  |
| **E2E (Playwright + Chromium)** | **`apps/web/e2e/*.spec.ts`**  | **The slice 1 → 3 UI surfaces work together from a real browser at the mobile baseline, including IME-locale behaviour the unit layer cannot observe.** |

That ordering matters: the unit suite stays fast (~5 s), the conformance suite stays opt-in (Docker required), and the E2E suite stays opt-in for the same reason (browser download required). Defaulting all three to "off in `pnpm -r test`" keeps the inner-loop cheap.
