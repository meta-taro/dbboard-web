# Design

Visual and interaction specification for **dbboard-web**.

> Status: **Colors** describes what is shipped and is enforced by a test. The
> remaining sections are still starting points, to be refined as the components
> they describe land.

## Visual direction

- Simple, fast, and dense — this is a developer tool, not a marketing site.
- Avoid decorative cards, gradients, drop shadows, and unnecessary animation.
- Information density over whitespace. Prefer tables, trees, and inline editors.
- Prefer keyboard navigation; the mouse should always be optional.

## Colors

Declared once, in `apps/web/app/app.vue`. Everything else consumes them through
`var(--token)` — never a literal, and never a `var(--token, #fallback)`, because
a fallback pins one theme's colour in place and looks deliberate. Both rules are
enforced by `apps/web/tests/theme-tokens.test.ts`.

| Token                | Light                  | Dark                    | Usage                                        |
| -------------------- | ---------------------- | ----------------------- | -------------------------------------------- |
| `bg`                 | `#ffffff`              | `#0b0d10`               | Page background                              |
| `surface`            | `#f5f6f8`              | `#14181d`               | Panels, sidebars                             |
| `surface-raised`     | `#ffffff`              | `#14181d`               | Content sitting on `surface` (grid cells)    |
| `surface-sunken`     | `rgba(15,17,21,.02)`   | `rgba(230,233,238,.03)` | Recessed rows, zebra striping                |
| `border`             | `#e3e6ea`              | `#1f242a`               | Dividers                                     |
| `border-faint`       | `#eef1f4`              | `#171c21`               | Grid rules, low-emphasis separators          |
| `text`               | `#0f1115`              | `#e6e9ee`               | Body text                                    |
| `text-muted`         | `#5a6573`              | `#8a96a3`               | Secondary text                               |
| `accent`             | `#2563eb`              | `#3b82f6`               | Primary action                               |
| `accent-contrast`    | `#ffffff`              | `#ffffff`               | Foreground on an `accent` fill               |
| `success`            | `#16a34a`              | `#22c55e`               | Successful query, healthy connection         |
| `success-text`       | `#166534`              | `#86efac`               | Success wording (the fill is too light/dark) |
| `success-tint`       | `rgba(34,197,94,.15)`  | `rgba(34,197,94,.2)`    | Success banner background                    |
| `warning`            | `#d97706`              | `#f59e0b`               | Truncated result, soft limit                 |
| `danger`             | `#dc2626`              | `#ef4444`               | Destructive action, errors                   |
| `danger-text`        | `#991b1b`              | `#fca5a5`               | Error wording                                |
| `danger-tint`        | `rgba(220,38,38,.1)`   | `rgba(239,68,68,.16)`   | Error banner background                      |
| `danger-tint-border` | `rgba(220,38,38,.3)`   | `rgba(239,68,68,.38)`   | Error banner border                          |
| `muted-tint`         | `rgba(120,113,108,.1)` | `rgba(138,150,163,.12)` | Neutral chip background                      |
| `muted-tint-border`  | `rgba(120,113,108,.3)` | `rgba(138,150,163,.32)` | Neutral chip border                          |
| `code-bg`            | `rgba(15,17,21,.06)`   | `rgba(230,233,238,.1)`  | Inline `code`                                |
| `scrim`              | `rgba(0,0,0,.45)`      | `rgba(0,0,0,.6)`        | Backdrop behind a modal                      |

The `*-text` pairs exist because the fill colours are tuned for solid blocks and
only just clear AA as body text. The tints carry a different alpha per theme —
the same alpha over a dark canvas disappears.

`scrim` is black in both themes rather than a wash of the canvas colour: its job
is to push the page back, and over a dark canvas a dark-grey wash is invisible.
The light theme takes more of it, because there is more to push back.

### Light / Dark / Auto

Mirrors desktop ADR-0041. Three states, in this cascade order:

| State | Selector                                           | Attribute on `<html>` |
| ----- | -------------------------------------------------- | --------------------- |
| Light | `:root`                                            | `data-theme="light"`  |
| Auto  | `:root:not([data-theme="light"])` in a media query | _(none)_              |
| Dark  | `:root[data-theme="dark"]`                         | `data-theme="dark"`   |

**Auto is the default and writes no attribute at all.** A resolved value in the
DOM would be a second source of truth that stops tracking when the OS setting
changes. The explicit dark block comes last so it outranks the media query at
equal specificity — that is what lets someone on a dark OS choose light.

`color-scheme` is declared per state rather than once as `light dark`. Declaring
both while the custom properties were light-only was the original defect: the UA
painted a dark canvas and every panel stayed white.

The preference persists under `localStorage["dbboard.theme"]`. Following
ADR-0041, reading it is non-fatal — missing, malformed, or a storage that throws
all fall back to auto rather than failing the render. UI chrome must not be able
to block startup.

## Layout

- Base spacing unit: `4px`. Use multiples (`4 / 8 / 12 / 16 / 24 / 32`).
- Border radius: `4px` for inputs and small chips, `8px` for panels. No radius on table cells.
- Sidebar default width: `280px`, resizable — see [Sidebar divider](#sidebar-divider).
  Result pane fills the remainder.
- Single primary scroll container per pane.

## Typography

- UI: system stack — `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`.
- Code / SQL editor: `"JetBrains Mono", ui-monospace, "SF Mono", monospace`.
- Scale: `12 / 13 / 14 / 16 / 20 / 24`. Default body `14px`.
- Line height: `1.4` for body, `1.5` for editor.

## Components

### Buttons

- Variants: primary, secondary (outline), ghost, danger.
- Single height (`32px`). Icon-only buttons must declare `aria-label`.
- No animated micro-interactions beyond a 100ms color transition.

### Forms

- Labels above inputs, error text below.
- Validate on blur, not on every keystroke.
- Required fields are marked with text (e.g. `(required)`), not color alone.

### Tables

- Sticky header.
- Virtualize rows when the count exceeds `500`.
- Numeric columns: right-aligned, monospace.
- Null and empty values render as a muted `NULL` glyph rather than blank cells.
- Export controls sit in a toolbar directly above the grid, never inside it —
  the grid's own root element is the virtualizer's scroll container.
- Copy leaves nothing on screen to notice, so both actions share one live
  region (`role="status"`), rendered from the start and empty. A region that
  appears at the same moment it gains text is not reliably announced.
- The whole header cell is the sort button, not an arrow beside the name — a
  glyph-sized target is a miss on touch, and the column name is what the eye
  aims at. The cell's padding moves onto the button so the hit area matches
  what is drawn.
- Sort direction lives in `aria-sort` on the `<th>`; the ▲ / ▼ glyph is
  `aria-hidden`, because a screen reader announcing both would say it twice.
  The level number appears only once more than one column sorts, and is
  spelled out for screen readers separately (`Sort level 2`).
- Double-clicking a cell the column could not show in full opens it in a
  read-only viewer. "In full" is measured in display columns, not characters:
  Japanese prose is twice as wide as its length suggests, and an emoji is half
  as wide. The threshold is `40`, matching the desktop client so a value opens
  at the same point on both.
- A value containing a newline always opens, however short. A cell renders on
  one line whatever it holds, so the second line is not visible anywhere until
  the value is opened — this is about not losing data on screen, not comfort.
- NULL and blob cells never open. Both reach the screen as placeholders rather
  than as their value, so the viewer would show what the cell already shows.
- The viewer keeps the value's line breaks and wraps rather than scrolling
  sideways. It carries a copy button with the same live-region acknowledgement
  as the export toolbar, and a visible close button — Escape does not exist on
  a phone, and a backdrop nobody knows to tap is not a way out.

### Error banners

One component renders every error the app shows (`ErrorBanner.vue`, mirroring
desktop ADR-0039). Nothing else assembles an error line.

- Two halves: the message in the reader's language, and — dimmed, below it —
  the same message in English. The English one is what can be pasted into a
  search or an assistant, so it is on screen rather than one click away.
- The second line appears only when it differs. On an English UI it would
  repeat the line above, which reads as a bug.
- Only the prefix is translated. The body comes from the database engine, not
  from dbboard, so translating it would mean inventing wording for someone
  else's error. When there is no body — a failure the client itself noticed —
  the prefix stands alone, with no dangling colon.
- A copy button takes both halves, newline-separated. It acknowledges in a
  live region that is a **sibling** of the banner, not inside it: text changing
  inside a `role="alert"` re-announces the whole alert, so a screen reader user
  would hear the error again on every press.
- `dense` tightens the padding and type for a banner inside a sidebar or a
  panel. Pages use the default.

### Sidebar divider

The editor and the sidebar are separated by a draggable divider
(`SidebarSplitter.vue`, mirroring desktop ADR-0083). The page publishes the
resulting width as a `--sidebar-width` custom property; nothing else sizes the
sidebar.

- Drawn as a hairline in `--border`, `--accent` on hover and while dragging,
  but padded out to a 44px grab target. A 7px handle is a mouse-only control.
- A real `role="separator"` with `tabindex="0"`: `←` / `→` move it `16px` at a
  time and `Home` resets it. Reachable-only-by-drag is not reachable.
- Default `280px`, floor `160px`, ceiling `640px`, and never more than half the
  window. On a window too narrow for both, the floor wins — a cramped sidebar
  beats an unreadable one, and the grid can scroll.
- The width the user chose is stored; the width applied is derived from it and
  the window as it is now. Narrowing the window squeezes the sidebar and
  widening it restores the choice, so what is stored is never clamped.
- Double-click, or `Home`, returns to the default **and forgets** the stored
  width. Restoring the position while keeping the preference would be a lie the
  next reload exposes.
- Persisted under `localStorage["dbboard.sidebarWidth"]`, non-fatally: as with
  the theme (ADR-0041), a storage that throws falls back to the default rather
  than failing the render.
- Hidden below `768px`, where the two panes stack and a vertical divider would
  resize nothing.

### Editors

- SQL editor: Monaco or CodeMirror (decision deferred). Run shortcut: `Cmd/Ctrl + Enter`.
- Syntax highlighting per dialect (PostgreSQL, libSQL).

## Responsive

- Optimized for desktop (`>= 1280px`).
- Tablet (`>= 768px`): collapse sidebar to overlay drawer.
- Mobile: read-only mode with a simplified result viewer (no editor).

## Accessibility

- All interactive elements reachable via keyboard.
- Visible focus ring on `:focus-visible`.
- Color is never the sole indicator — always pair with text or icon.
- Sufficient contrast ratios for both themes (target WCAG AA).
