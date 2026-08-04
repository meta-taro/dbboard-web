/**
 * Sidebar sizing — the pure half. Mirrors desktop ADR-0083.
 *
 * The divider component owns the pointer plumbing and the composable owns
 * storage; this module owns the two things worth testing on their own — what
 * widths are legal, and how a stored one is read back without trusting it.
 *
 * Nothing here touches `window` or `localStorage`. The same line desktop draws
 * between `$lib/layout/splitter` and the shell, and the one `utils/theme.ts`
 * draws against `useTheme`.
 */

/**
 * Where the divider sits before anyone touches it, and where a reset puts it
 * back. `DESIGN.md` has promised 280px since before the sidebar was resizable.
 */
export const SIDEBAR_DEFAULT_WIDTH = 280;

/**
 * Narrow enough to give the grid room, wide enough that a table name is still
 * readable rather than an ellipsis.
 */
export const SIDEBAR_MIN_WIDTH = 160;

/** Absolute ceiling, for schema-qualified names on a wide monitor. */
export const SIDEBAR_MAX_WIDTH = 640;

/** How far one arrow-key press moves the divider. */
export const SIDEBAR_NUDGE = 16;

/** Namespaced: `localStorage` is shared by everything on the origin. */
export const SIDEBAR_WIDTH_STORAGE_KEY = "dbboard.sidebarWidth";

/**
 * On a narrow window the absolute ceiling is meaningless — the result grid is
 * the point of the app, so the sidebar never takes more than this share.
 */
const MAX_VIEWPORT_FRACTION = 0.5;

/**
 * Clamp a candidate sidebar width to something usable in a `viewportWidth`-wide
 * window.
 *
 * The minimum wins over the viewport cap (ADR-0083 decision 4): on a window too
 * narrow for both panes, a cramped sidebar beats an unreadable one, and the
 * grid can scroll.
 */
export function clampSidebarWidth(width: number, viewportWidth = Number.POSITIVE_INFINITY): number {
  if (!Number.isFinite(width)) return SIDEBAR_DEFAULT_WIDTH;
  const viewportCap = Number.isFinite(viewportWidth)
    ? Math.floor(viewportWidth * MAX_VIEWPORT_FRACTION)
    : SIDEBAR_MAX_WIDTH;
  const ceiling = Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, viewportCap));
  return Math.round(Math.min(Math.max(width, SIDEBAR_MIN_WIDTH), ceiling));
}

/**
 * Read a stored width without trusting it.
 *
 * No viewport is taken, and that is the point of ADR-0083 decision 3: what is
 * stored is the width the user *chose*, not the width that fitted at the time.
 * Narrowing the window squeezes the sidebar, but widening it again has to
 * restore the choice, so clamping to a viewport on the way in would quietly
 * destroy it.
 *
 * `Number("")` is `0` and `Number(null)` is `0`, so a plain conversion would
 * read an empty key as a width and hand back the minimum. Only a string or
 * number that actually spells a finite number is accepted.
 */
export function parseSidebarWidth(raw: unknown): number {
  if (typeof raw === "number") {
    return Number.isFinite(raw) ? clampSidebarWidth(raw) : SIDEBAR_DEFAULT_WIDTH;
  }
  if (typeof raw !== "string" || raw.trim() === "") return SIDEBAR_DEFAULT_WIDTH;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? clampSidebarWidth(parsed) : SIDEBAR_DEFAULT_WIDTH;
}
