import { describe, expect, it } from "vitest";
import {
  DEFAULT_THEME_PREFERENCE,
  THEME_STORAGE_KEY,
  parseThemePreference,
  resolveTheme,
  themeAttribute,
} from "../app/utils/theme";

// Mirrors desktop ADR-0041. The pure half lives here so the three-way
// preference and its fallbacks are testable without a DOM, a media query, or
// a storage backend — the same split desktop made between `ui_settings` and
// the egui call site.

describe("parseThemePreference", () => {
  it("accepts the three documented values", () => {
    expect(parseThemePreference("light")).toBe("light");
    expect(parseThemePreference("dark")).toBe("dark");
    expect(parseThemePreference("auto")).toBe("auto");
  });

  // Desktop ADR-0041: "Loading is non-fatal … a missing, malformed, or
  // version-incompatible ui-settings.toml never errors". Web's storage fails
  // in more ways than a file does — absent during SSR, throwing in Safari
  // private mode, and writable by anything else on the origin.
  it("falls back to the default for anything it does not recognise", () => {
    expect(parseThemePreference(null)).toBe(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference(undefined)).toBe(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference("")).toBe(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference("Dark")).toBe(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference("system")).toBe(DEFAULT_THEME_PREFERENCE);
    expect(parseThemePreference('{"theme":"dark"}')).toBe(DEFAULT_THEME_PREFERENCE);
  });

  it("defaults to auto, so a first-time visitor follows the OS", () => {
    expect(DEFAULT_THEME_PREFERENCE).toBe("auto");
  });
});

describe("resolveTheme", () => {
  it("an explicit choice ignores the OS preference", () => {
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("auto follows the OS preference", () => {
    expect(resolveTheme("auto", true)).toBe("dark");
    expect(resolveTheme("auto", false)).toBe("light");
  });
});

describe("themeAttribute", () => {
  // Invariant 5 of ticket 0025: a stored "auto" and an absent key must be
  // indistinguishable. Both produce no attribute, which leaves the CSS media
  // query as the only thing deciding — so there is no second code path that
  // could disagree with it.
  it("auto sets no attribute at all", () => {
    expect(themeAttribute("auto")).toBeNull();
    expect(themeAttribute(parseThemePreference(null))).toBeNull();
  });

  it("an explicit choice names itself, so CSS can override the media query", () => {
    expect(themeAttribute("light")).toBe("light");
    expect(themeAttribute("dark")).toBe("dark");
  });
});

describe("THEME_STORAGE_KEY", () => {
  // Namespaced because localStorage is shared across everything served from
  // the origin. Pinned because changing it silently discards every existing
  // visitor's preference.
  it("is namespaced to the app", () => {
    expect(THEME_STORAGE_KEY).toBe("dbboard.theme");
  });
});
