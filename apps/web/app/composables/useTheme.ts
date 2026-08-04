/**
 * Light / Dark / Auto, persisted. Mirrors desktop ADR-0041.
 *
 * The decision logic lives in `~/utils/theme` and is testable without a DOM.
 * This composable owns only the three things that can fail on the web:
 * `localStorage`, `matchMedia`, and the attribute on `<html>`.
 *
 * ADR-0041 makes loading non-fatal — "UI chrome must not be able to block
 * startup" — and every one of those three needs that treatment here:
 *
 * - `localStorage` throws outright in Safari private mode (read *and* write),
 *   is absent during SSR, and can be written by anything else on the origin.
 * - `matchMedia` is missing in some embedded webviews.
 * - Persistence is best-effort. A failed write must not undo the choice the
 *   user just made, so the in-memory preference is the source of truth and
 *   storage is a side effect of it.
 *
 * `auto` deliberately writes no attribute, leaving the stylesheet's
 * `prefers-color-scheme` query as the only decider. See `themeAttribute`.
 *
 * Vue lifecycle helpers are imported explicitly rather than auto-imported so
 * the composable mounts in a plain happy-dom Vitest environment.
 */
import { computed, onBeforeUnmount, onMounted, readonly, ref } from "vue";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  type ResolvedTheme,
  type ThemePreference,
  parseThemePreference,
  resolveTheme,
  themeAttribute,
} from "../utils/theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

function readStoredPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    // Private mode, a disabled-storage policy, or no window at all.
    return DEFAULT_THEME_PREFERENCE;
  }
}

function writeStoredPreference(pref: ThemePreference): void {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, pref);
  } catch {
    // Best-effort: the choice still applies for this session.
  }
}

function darkMediaQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  return window.matchMedia(DARK_QUERY);
}

export function useTheme() {
  // Starts at the default so server-rendered markup and the first client
  // render agree; the stored value is read in onMounted.
  const preference = ref<ThemePreference>(DEFAULT_THEME_PREFERENCE);
  const prefersDark = ref(false);

  const resolved = computed<ResolvedTheme>(() => resolveTheme(preference.value, prefersDark.value));

  function applyAttribute(pref: ThemePreference): void {
    if (typeof document === "undefined") return;
    const attr = themeAttribute(pref);
    const root = document.documentElement;
    if (attr === null) {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", attr);
    }
  }

  function setPreference(pref: ThemePreference): void {
    preference.value = pref;
    applyAttribute(pref);
    writeStoredPreference(pref);
  }

  let mql: MediaQueryList | null = null;

  function onMediaChange(event: MediaQueryListEvent | MediaQueryList): void {
    prefersDark.value = event.matches;
  }

  onMounted(() => {
    preference.value = readStoredPreference();
    applyAttribute(preference.value);

    mql = darkMediaQuery();
    if (!mql) return;
    prefersDark.value = mql.matches;
    // `addListener` is the deprecated form; Safari < 14 has only that one.
    if (typeof mql.addEventListener === "function") {
      mql.addEventListener("change", onMediaChange);
    } else {
      mql.addListener(onMediaChange);
    }
  });

  onBeforeUnmount(() => {
    if (!mql) return;
    if (typeof mql.removeEventListener === "function") {
      mql.removeEventListener("change", onMediaChange);
    } else {
      mql.removeListener(onMediaChange);
    }
    mql = null;
  });

  return {
    preference: readonly(preference),
    resolved,
    setPreference,
  };
}
