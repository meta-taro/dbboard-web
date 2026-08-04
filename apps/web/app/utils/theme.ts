/**
 * Theme preference — the pure half. Mirrors desktop ADR-0041.
 *
 * Desktop stores `ThemePreference { Light, Dark, Auto }` in `ui-settings.toml`
 * and maps it onto `egui::ThemePreference`, letting egui track the OS. Web's
 * equivalent of "let the platform do it" is the `prefers-color-scheme` media
 * query, so `auto` deliberately resolves to *nothing*: no attribute is set and
 * the stylesheet's media query is the only thing deciding. That is why
 * `themeAttribute("auto")` returns `null` rather than `"light"` — a resolved
 * value written into the DOM would be a second source of truth that stops
 * tracking the moment the OS setting changes.
 *
 * Nothing here touches `localStorage`, `document` or `matchMedia`; the
 * composable supplies those. Desktop drew the same line between
 * `dbboard-config::ui_settings` and the egui call site.
 */

export type ThemePreference = "light" | "dark" | "auto";
export type ResolvedTheme = "light" | "dark";

export const DEFAULT_THEME_PREFERENCE: ThemePreference = "auto";

/** Namespaced: `localStorage` is shared by everything on the origin. */
export const THEME_STORAGE_KEY = "dbboard.theme";

export const THEME_PREFERENCES: readonly ThemePreference[] = ["auto", "light", "dark"];

/**
 * Read a stored value without trusting it.
 *
 * Desktop ADR-0041 makes loading non-fatal because "UI chrome must not be able
 * to block startup". Web has more ways to get a surprise than a TOML file
 * does: the key is absent during SSR, `localStorage` throws outright in Safari
 * private mode, and any other script on the origin can overwrite it. So the
 * only accepted inputs are the three exact strings.
 */
export function parseThemePreference(raw: unknown): ThemePreference {
  return raw === "light" || raw === "dark" || raw === "auto" ? raw : DEFAULT_THEME_PREFERENCE;
}

export function resolveTheme(pref: ThemePreference, prefersDark: boolean): ResolvedTheme {
  if (pref === "auto") return prefersDark ? "dark" : "light";
  return pref;
}

/**
 * The value for `<html data-theme>`, or `null` to leave the attribute off.
 *
 * `null` for `auto` is what makes a stored `auto` and an absent key
 * indistinguishable (ticket 0025 invariant 5).
 */
export function themeAttribute(pref: ThemePreference): ResolvedTheme | null {
  return pref === "auto" ? null : pref;
}
