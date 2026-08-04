# 0025 — Grid and UX parity (rung 3)

- **Status:** in progress (opened 2026-08-04)
- **Rung:** 3 of [`parity-ledger.md`](../parity-ledger.md)
- **Mirrors:** desktop ADR-0041, ADR-0035, ADR-0048, ADR-0082, ADR-0039, ADR-0083

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
- [ ] Slice B — `to_csv` / `to_tsv` equivalents are pure and unit-tested; copy
      and download wired to the grid.
- [ ] Slice C — `sortedRowOrder` is pure; header clicks cycle asc → desc → off;
      up to three levels; a new result resets the sort.
- [ ] Slice D — `displayWidth` / `needsViewer` are pure and unit-tested at the
      boundary; a value containing a newline always opens the viewer.
- [ ] Slice E — one error primitive carrying both halves, with a copy button,
      used by every surface that renders an error.
- [ ] Slice F — divider is a real `role="separator"` with keyboard support;
      `placePopover` is DOM-free and unit-tested for the flip and clamp cases.
- [ ] `DESIGN.md` no longer promises anything the code does not do.
- [ ] `pnpm format:check && pnpm -r lint && pnpm -r typecheck && pnpm -r test`
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
