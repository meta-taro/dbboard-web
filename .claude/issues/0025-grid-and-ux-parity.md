# 0025 — Grid and UX parity (rung 3)

- **Status:** closed 2026-08-04 (opened 2026-08-04) — six slices, six commits,
  `a30e499` … `9ad14df`
- **Rung:** 3 of [`parity-ledger.md`](../parity-ledger.md)
- **Mirrors:** desktop ADR-0041, ADR-0035, ADR-0048, ADR-0082, ADR-0039, ADR-0083
- **ADR:** [`decisions.md`](../decisions.md) — "2026-08-04 — Grid and UX parity"

## Purpose

Six desktop behaviours the web grid and shell do not have. Unlike rung 2 these
are features, not bugs — but three of them are already promised by
[`DESIGN.md`](../../DESIGN.md), which makes those three a documentation drift
rather than an unbuilt idea.

## Re-derivation before starting

The ledger's own method note says to treat each row as a hypothesis and
re-derive it from both codebases. Doing that changed three of the six rows:

| Row      | Ledger said                               | Actually                                                                                                                                                                                                                                                                                                                   |
| -------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ADR-0041 | "dark mode appears only as a media query" | Worse than that. `app.vue` sets `color-scheme: light dark`, which makes the UA paint a **dark canvas** on a dark-preferring OS, but every custom property is light-only (`--border: #e3e6ea`) and `ResultGrid.vue` falls back to `#ffffff`. Dark mode is broken today, not merely absent. This is a bug, so it goes first. |
| ADR-0039 | "web drops the original English"          | Half right. The **body** is already verbatim English (it comes from the database, and web never translates it). What is dropped is the English of the **localized prefix**, and — the point of the ADR — there is no copy affordance anywhere.                                                                             |
| ADR-0082 | listed plainly as a rung-3 item           | Its Decisions 1–4 and 6–7 are about the **inline editor**, which is rung 6. Only Decision 5 ("the read-only popup uses the same test") is portable now. Web has no read-only popup at all, so the portable scope is: a viewer for values too wide to render.                                                               |

ADR-0035, ADR-0048 and ADR-0083 stand as written.

One thing carried in from desktop that is easy to miss: ADR-0082 Decision 3 —
**"long" is measured in display columns, not `.length`**. Twenty-five
characters of Japanese occupy fifty columns and are long since truncated, so a
`.length` threshold never fires for the users most likely to need the viewer.
ADR-0083 Decision 6 has the same shape: an absolutely positioned popover is
clipped by any scrolling ancestor, and no `max-height` fixes that.

## Slices

Each slice is its own commit, and each is independently shippable.

| Slice | Mirrors  | Scope                                                                        |
| ----- | -------- | ---------------------------------------------------------------------------- |
| A     | ADR-0041 | Light / dark / auto theme, persisted. Full dark palette from `DESIGN.md`.    |
| B     | ADR-0035 | CSV / TSV export of a result set: copy TSV, download CSV.                    |
| C     | ADR-0048 | Client-side multi-column sort, up to three levels, as a display permutation. |
| D     | ADR-0082 | A viewer for cell values too wide to render, measured in display columns.    |
| E     | ADR-0039 | Localized + original English error display, both copyable.                   |
| F     | ADR-0083 | Draggable sidebar divider; popovers placed with explicit coordinates.        |

Slice A goes first because it is the only one that is a defect, and because
desktop's ADR-0041 consequence applies to every slice after it: **colours
introduced later must read from the active theme, not hard-coded RGB.**

## Invariants

1. **Display width, not string length.** CJK, kana, Hangul and emoji count as
   two columns; iteration is by code point so an astral character counts once.
   Used by slice D, and by slice C's tie-breaking only if it needs text
   comparison (it does not — see invariant 4).
2. **Sorting reorders display, not data.** A permutation of row indices, never
   a mutated `rows` array. Rung 6 will stage edits keyed on the real index, and
   a sorted-in-place array silently remaps them.
3. **Export writes what a spreadsheet expects, not what the grid shows.** NULL
   serializes as an empty field, not the literal `NULL`. RFC 4180 quoting on
   both formats. Records separated, not terminated.
4. **The sort order is dbboard's own, not the engine's.** A fixed total order
   (NULLs first, then numbers by magnitude, then text, then blobs) that cannot
   panic. It may differ from what `ORDER BY` would return; that is intentional
   and must be stated where the comparator lives.
5. **Theme "auto" is the media query, and it must be indistinguishable from no
   preference at all.** A stored `auto` and an absent key resolve identically.
6. **A missing or malformed stored preference never blocks render.** Desktop
   ADR-0041: UI chrome must not be able to break startup. `localStorage` throws
   in Safari private mode and is absent during SSR.
7. **Every new visible string is added to all 11 locales.** `i18n-locale-parity`
   fails CI otherwise. Technical literals (`NULL`, `<blob: N chars>`, SQL) stay
   out of i18n, per the existing convention in `format-value.ts`.

## Acceptance

- [x] Slice A — theme resolves light/dark/auto, persists, survives a missing or
      malformed stored value, and every surface reads theme tokens.
- [x] Slice B — `to_csv` / `to_tsv` equivalents are pure and unit-tested; copy
      and download wired to the grid.
- [x] Slice C — `sortedRowOrder` is pure; header clicks cycle asc → desc → off;
      up to three levels; a new result resets the sort.
- [x] Slice D — `displayWidth` / `needsViewer` are pure and unit-tested at the
      boundary; a value containing a newline always opens the viewer.
- [x] Slice E — one error primitive carrying both halves, with a copy button,
      used by every surface that renders an error.
- [x] Slice F — divider is a real `role="separator"` with keyboard support, and
      the stored width survives a window too narrow to honour it. **The
      `placePopover` half was re-derived and dropped: web has nothing to place.**
      The only `position: fixed` element is `CellViewer`'s centered modal
      backdrop, `ResultGrid`'s only `position: absolute` is a `.visually-hidden`
      utility, and the history is a docked sidebar column rather than a
      toolbar-anchored popover. Shipping the module with no consumer would have
      been dead code and a test suite guarding nothing; ADR-0083 decisions 6–7
      come back with the first popover that needs them.
- [x] `DESIGN.md` no longer promises anything the code does not do.
- [x] `pnpm format:check && pnpm -r lint && pnpm -r typecheck && pnpm -r test`
      all exit 0.

## Verification

```sh
pnpm format:check
pnpm -r lint
pnpm -r typecheck
pnpm -r test
```

## Log

- 2026-08-04 — Opened. Re-derived all six rows against `apps/web/app/`; three
  needed correcting before any code (table above).
- 2026-08-04 — Slice A done. Three RED-first cycles: `utils/theme.ts` (pure
  resolution), `composables/useTheme.ts` (storage, media query, the attribute),
  `components/ThemeSwitcher.vue`. Palette rewritten to three states and swept
  across nine consumer files; eleven new tint / text tokens, because the sweep
  turned up five `rgba()` literals that no existing token covered.
  - `theme-tokens.test.ts` enforces ADR-0041's carry-forward rule for slices
    B–F: no colour literal and no `var(--x, fallback)` outside the shell.
  - That test first shipped **vacuous**. `indexOf(':root[data-theme="dark"]')`
    matched the prose in the comment documenting the selectors, then walked to
    the next `{`, so all three sets read the light block and "dark matches
    light" compared the light block with itself. Found by deleting a token and
    watching it still pass. Now strips comments, requires `\s*{` after the
    selector, and brace-matches. Deleting a token now fails it.
  - `window.localStorage` is inert under vitest here — Node's experimental Web
    Storage global shadows happy-dom's. The tests supply their own store, which
    is also what makes the throw-on-read / throw-on-write cases expressible.
- 2026-08-04 — Slice B done, mirroring desktop ADR-0035 assertion for
  assertion: `utils/export.ts` (pure serialization), `useResultExport`
  (clipboard + download), `ResultExportToolbar.vue`, `result.export.*` in
  eleven locales.
  - Format decisions carried over verbatim: RFC 4180 quoting shared by both
    formats, NULL as an empty field rather than the word, records separated
    and not terminated, CSV with a BOM for Excel and clipboard TSV without
    one, blobs exporting their `<blob: N chars>` placeholder.
  - Two desktop concerns deliberately dropped. `next_available_name` exists
    because a native save dialog overwrites silently; the browser's download
    manager de-duplicates already. ADR-0035 slice 2's row selection is out of
    scope — nothing in the web grid selects rows yet.
  - Web-only cases desktop has no equivalent for: a blob arrives as
    `{ $blob }` over the wire, and a lone `\r` has to quote (a Windows
    clipboard paste can produce one without a `\n`).
  - `navigator.clipboard` is undefined outside a secure context — the first
    way anyone running the API on a LAN box meets the copy button — and
    rejects on a denied permission. Both land in the status region rather
    than an exception.
  - Neither the composable nor the component was written test-first in the
    strict sense (module followed test within the same cycle), so both were
    mutation-checked instead of trusted: swapping `toTsv` for `toCsvWithBom`,
    then the filename and `aria-live`, each produced the expected failures.
- 2026-08-04 — Slice C done, from desktop ADR-0048 plus the shipped
  `dbboard-core/src/sort.rs` and `SortState` in `dbboard-ui`:
  `utils/sort.ts` (pure order), `useResultSort` (keys, permutation,
  indicator), header buttons in `ResultGrid.vue`, `result.sort.*` in eleven
  locales. The desktop suite ported case for case.
  - Sorting reorders display only. `sortedRowOrder` returns a permutation of
    indices, the grid resolves each virtual slot through it, and every row
    carries `data-row-index` with its real index — which is what rung 6 will
    key staged edits on. A test pins that `result.rows` is byte-identical
    after a sort.
  - Rust's `f64::total_cmp` has no JS equivalent. `<` leaves NaN incomparable
    and calls `-0 < 0` false, so a comparator built on it returns 0 for those
    pairs and the sort may place them anywhere. Reinterpreting the double's
    bits as a sign-magnitude integer and folding the negative half reproduces
    the total order; NaN and `-0` are pinned by test.
  - Two places where the web shape differs from the desktop one. Rust's
    `Value` splits Integer and Real, which JS does not have, so `rank` has
    three buckets after NULL instead of four and mixed int/real comparison
    disappears. And a ragged row is `column >= row.length` rather than
    `Option`, with the same rule: a missing cell sorts ahead of a present one.
  - Strings compare by code unit, deliberately not `localeCompare` — the same
    result must not sort two ways on two machines.
  - Desktop caches the permutation behind a `dirty` flag; a Vue `computed` is
    that cache, so the flag has no counterpart. The reset-on-new-result rule
    survives as a `watch` on the result's identity, not its row count: a
    re-run returning the same number of rows still gets a fresh sort, because
    the columns may mean something else entirely.
  - `aria-sort` on the `<th>` carries the direction and the ▲/▼ glyph is
    `aria-hidden`, so a screen reader does not say it twice. The level number
    renders only once more than one column sorts, with a translated
    `Sort level N` for screen readers beside it.
  - `ResultGrid` had no vue-i18n mock in its test because it had no strings;
    adding the header button's title needed one.
  - The component and composable followed their tests within the same cycle
    rather than strictly before, so both were mutation-checked: collapsing
    `rowIndexFor` to the identity and dropping the level number produced ten
    failures across the two environments.

### 2026-08-04, slice D

Read-only cell viewer, desktop ADR-0082 decisions 3-5. `displayWidth` and
`needsViewer` in `app/utils/display-width.ts` are a byte-for-byte port of the
thirteen full-width ranges in `apps/desktop/src/lib/grid/edit.ts`;
`CellViewer.vue` renders, and `ResultGrid.vue` decides.

- The threshold is exported as `VIEWER_COLUMN_THRESHOLD`, not
  `INLINE_EDITOR_COLUMNS`. Desktop's constant gates two consumers — the
  read-only popup and the inline editor — and web has only the first until
  rung 6. Naming it for the editor that does not exist yet would be naming it
  for the wrong thing; the editor can justify sharing it when it arrives.
- Both halves of "display width" earn their place. Counting UTF-16 units
  scores an emoji double, and counting characters scores Japanese half. Only
  code points weighted by width get both right, and the fixtures pin both
  directions: `🎉` is 2 wide while its `.length` is 2, and `日本` is 2 wide
  per character against a `.length` of 1.
- Two web-specific additions to desktop's popup, both recorded in the
  component header. A copy acknowledgement in a live region, for the same
  reason slice B gave: a copy leaves nothing on screen to notice. And a
  visible close button, because Escape does not exist on a phone and a
  backdrop nobody knows to tap is not a way out.
- The grid passes `rowIndexFor(vRow.index)`, never the display index. A viewer
  showing a value that belongs to a different row than the one clicked would
  be worse than not opening at all.
- The sorted case in `result-grid.test.ts` was written against a descending
  sort, which for that fixture is the identity permutation — the case was
  vacuous and a mutation to the display index survived it. Ascending is the
  ordering where the two indices disagree; rewritten against it, and it now
  asserts both rows, not one.
- The NULL and blob guards survive mutation because `formatValue` renders both
  as placeholders short enough for the width test to reject anyway. That is a
  fact about `format-value`, not about what may be opened, and it stops being
  true the day a blob renders its bytes. The guard now tests the raw value
  rather than its text, and both the module and the test say plainly that
  those two cases pin the behaviour and not the branch.
- The viewer needed a modal backdrop, and slice A's own rule refused the
  literal that would have been the obvious way to write it. The palette had no
  scrim, so one was added to all three theme blocks. It is black in both
  themes rather than a wash of the canvas colour — over a dark canvas a
  dark-grey wash does not read as a scrim at all — with more of it in the
  light theme, where there is more page to push back.

### 2026-08-04, slice E

- `DisplayError` is desktop ADR-0039's pair — the message the reader can read
  and the English one they can search — and `ErrorBanner.vue` is the one place
  that renders it. Before this, five surfaces each assembled `prefix: message`
  by hand and each carried its own copy of the same banner CSS, and the
  English half existed nowhere: an error a user could not read was also an
  error they could not look up.
- The English half is a static import of `en.json`, not `t(key, { locale:
"en" })`. `i18n.lazy` is on, so on a Japanese session the English bundle may
  not be in memory, and a half that is sometimes the sentence and sometimes
  the raw key is worse than no half at all.
- That import has to be `?raw`. A plain JSON import of a locale file does not
  yield the JSON — @nuxtjs/i18n compiles locale files into vue-i18n message
  AST nodes, so `en.error.prefix.query` is an object and interpolating it
  gives `[object Object]`. The first version shipped exactly that, and the
  test caught it. `i18n-locale-parity.test.ts` had already hit the same wall
  and documents it at the top; the fix here is the same trick. There is now a
  case pinning the subtree behaviour, so a key naming a branch rather than a
  message reads as unresolved instead of stringifying.
- The test reads `en.json` off disk rather than importing it. Its first draft
  imported it, which made the "collapses to one half on an English UI" case
  pass for the wrong reason: both halves became `[object Object]: boom`, so
  they matched. Reading from disk also makes the test an independent source —
  the module reaches the same file through the bundler.
- `prefixed(key, message | null, t)` generalized out of `fromCategorised`
  before the call sites were touched. The schema browser and the history
  sidebar name their prefix outside `error.prefix.*`, and an `error.prefix.*`
  lookup would have silently dropped their English half. `null` for the body
  covers `schema.error.columns`, where the client itself noticed the failure
  and there is nothing from underneath — no dangling colon on either half.
- Only the prefix is translated. The body is the engine's own wording, and
  ADR-0039 draws the same boundary: translating it would mean inventing
  wording for someone else's error.
- The copy acknowledgement is a sibling of the alert, not inside it. Text
  changing inside a `role="alert"` re-announces the whole alert, so a screen
  reader user pressing Copy would hear the error read out again. There is a
  test for this specifically, and it dies when the live region is moved in.
- `ErrorBanner.vue` was written before its tests — the one place this slice
  broke RED-first order. Five mutations stand in for it (always render the
  original, copy the localized half only, move the status inside the alert,
  render the live region only once it has text, drop `role="alert"`); all five
  are caught. Recorded rather than glossed: mutation coverage is stronger
  evidence than ordering, but it is not the same thing as having followed the
  chain.
- Two call-site tests now assert the English half reaches the DOM. `t` is
  stubbed to echo keys in both suites, so the English wording can only have
  come from the bundle — that is what makes them wiring tests rather than
  restatements of the unit tests.

### 2026-08-04, slice F

- Re-derived against both codebases before writing anything, as the ledger's
  method note requires — and the derivation removed half the slice.
  `placePopover` (ADR-0083 decisions 6–7) has no consumer on web: the only
  `position: fixed` element is `CellViewer`'s centered modal backdrop, the only
  `position: absolute` in `ResultGrid` is a `.visually-hidden` utility, and the
  history is a docked sidebar column, not a toolbar-anchored popover. Porting
  it would have added a pure module nothing calls plus a test suite guarding
  nothing. Recorded in the acceptance line so the omission is a decision rather
  than a gap.
- Split three ways, along the same seam as `utils/theme.ts` / `useTheme`:
  `utils/splitter.ts` owns what widths are legal, `useSidebarWidth` owns
  storage and the window, and `SidebarSplitter.vue` owns pointers and keys.
  Only the middle one needs a DOM, and only the last one needs a component.
- ADR-0083 decision 3 is the whole reason `chosen` and `width` are separate
  refs. What is stored is the width the user asked for; what is applied is
  that clamped against the window as it is now. Clamping on write would
  destroy the preference at the moment it is least noticeable — drag the window
  narrow, and the sidebar you set to 600 is silently 450 forever.
- The minimum beats the viewport cap (decision 4). On a 200px window the
  sidebar is 160px and the grid scrolls, rather than both panes being
  unreadable.
- `parseSidebarWidth` refuses `Number()`'s helpfulness: `Number("")` and
  `Number(null)` are both `0`, so a plain conversion reads an absent key as a
  width and hands back the minimum. Only a string that actually spells a finite
  number is accepted.
- `nudge` steps from the width on screen, not the remembered one. On a squeezed
  sidebar the two differ, and stepping from storage makes the first arrow press
  appear to do nothing while the remembered width catches up. That is what
  justifies the composable owning `nudge` at all — the component emits a delta
  and never computes a width.
- Every pointermove is measured from where the press landed, not from the last
  move. Accumulating deltas drifts, and the divider lags the pointer by however
  many events the browser coalesced. Pointer capture is called defensively:
  some embedded WebViews ship pointer events without it, and a lost capture is
  a degraded drag rather than a broken page.
- The divider is hidden below `768px`. The panes stack there, so a vertical
  divider would resize nothing.
- RED-first throughout, correcting slice E's one ordering break. Mutation-
  checked at all three levels: 4 on the composable (derived width ignores the
  viewport, nudge steps from `chosen`, reset persists the default, listener
  never removed), 7 on the component (drag direction flipped, accumulate from
  last move, any button starts a drag, move without a press, capture never
  released, arrows swapped, pointercancel unhandled), 4 on the page wiring
  (width never reaches the layout, drag wired to nudge, reset never wired,
  splitter not mounted). All 15 caught, all restored green.
