import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOCALE,
  SUPPORTED_LOCALES,
  SUPPORTED_LOCALE_CODES,
  isSupportedLocale,
} from "../i18n/config";

// Pins the Stage 1 locale set (ADR-0008, mirrors desktop ADR-0015). Adding or
// removing a locale must update this test in the same commit.
describe("i18n config", () => {
  it("ships the 11 Stage 1 locales", () => {
    expect(SUPPORTED_LOCALE_CODES).toEqual([
      "en",
      "ja",
      "ko",
      "zh-CN",
      "zh-TW",
      "de",
      "fr",
      "es",
      "pt-BR",
      "ru",
      "it",
    ]);
  });

  it("defaults to en (the canonical key set)", () => {
    expect(DEFAULT_LOCALE).toBe("en");
    expect(SUPPORTED_LOCALE_CODES).toContain(DEFAULT_LOCALE);
  });

  it("points each entry at a JSON file matching its code", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(locale.file).toBe(`${locale.code}.json`);
      expect(locale.language).toBe(locale.code);
      expect(locale.name).not.toBe("");
    }
  });

  it("isSupportedLocale narrows known codes and rejects others", () => {
    expect(isSupportedLocale("ja")).toBe(true);
    expect(isSupportedLocale("zh-CN")).toBe(true);
    expect(isSupportedLocale("xx")).toBe(false);
    // Stage 2 candidates (ADR-0008) — proves they are not silently accepted.
    expect(isSupportedLocale("ar")).toBe(false);
    expect(isSupportedLocale("hi")).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(null)).toBe(false);
    expect(isSupportedLocale(123)).toBe(false);
  });
});
