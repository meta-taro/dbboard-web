# Design

Visual and interaction specification for **dbboard-web**.

> Status: placeholder. Tokens and components below are starting points to be refined when the first UI work lands.

## Visual direction

- Simple, fast, and dense — this is a developer tool, not a marketing site.
- Avoid decorative cards, gradients, drop shadows, and unnecessary animation.
- Information density over whitespace. Prefer tables, trees, and inline editors.
- Prefer keyboard navigation; the mouse should always be optional.

## Colors

Tentative tokens. Finalize during the first UI phase.

| Token | Light | Dark | Usage |
|---|---|---|---|
| `bg` | `#ffffff` | `#0b0d10` | Page background |
| `surface` | `#f5f6f8` | `#14181d` | Panels, sidebars |
| `border` | `#e3e6ea` | `#1f242a` | Dividers |
| `text` | `#0f1115` | `#e6e9ee` | Body text |
| `text-muted` | `#5a6573` | `#8a96a3` | Secondary text |
| `accent` | `#2563eb` | `#3b82f6` | Primary action |
| `success` | `#16a34a` | `#22c55e` | Successful query, healthy connection |
| `warning` | `#d97706` | `#f59e0b` | Truncated result, soft limit |
| `danger` | `#dc2626` | `#ef4444` | Destructive action, errors |

## Layout

- Base spacing unit: `4px`. Use multiples (`4 / 8 / 12 / 16 / 24 / 32`).
- Border radius: `4px` for inputs and small chips, `8px` for panels. No radius on table cells.
- Sidebar default width: `280px`, resizable. Result pane fills the remainder.
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
