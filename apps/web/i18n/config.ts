// Shared between nuxt.config.ts, the locale-query middleware, the
// LocaleSwitcher, and tests. Keep this file pure and runtime-free so it can be
// imported from any of those contexts.
//
// The `Locale` literal union narrows everything downstream: the array entries
// type, the type guard, and (via @nuxtjs/i18n's inference) the setLocale()
// argument type. Adding a locale means widening the union here.

export type Locale =
  | "en"
  | "ja"
  | "ko"
  | "zh-CN"
  | "zh-TW"
  | "de"
  | "fr"
  | "es"
  | "pt-BR"
  | "ru"
  | "it";

export interface SupportedLocale {
  code: Locale;
  language: Locale;
  name: string;
  file: string;
}

// Stage 1 locale set (ADR-0008, mirrors desktop ADR-0015). Adding a locale is
// a one-line edit here plus a JSON file under ./locales/. The parity test in
// tests/i18n-locale-parity.test.ts asserts every locale ships every en key.
export const SUPPORTED_LOCALES: SupportedLocale[] = [
  { code: "en", language: "en", name: "English", file: "en.json" },
  { code: "ja", language: "ja", name: "日本語", file: "ja.json" },
  { code: "ko", language: "ko", name: "한국어", file: "ko.json" },
  { code: "zh-CN", language: "zh-CN", name: "简体中文", file: "zh-CN.json" },
  { code: "zh-TW", language: "zh-TW", name: "繁體中文", file: "zh-TW.json" },
  { code: "de", language: "de", name: "Deutsch", file: "de.json" },
  { code: "fr", language: "fr", name: "Français", file: "fr.json" },
  { code: "es", language: "es", name: "Español", file: "es.json" },
  { code: "pt-BR", language: "pt-BR", name: "Português (Brasil)", file: "pt-BR.json" },
  { code: "ru", language: "ru", name: "Русский", file: "ru.json" },
  { code: "it", language: "it", name: "Italiano", file: "it.json" },
];

export const DEFAULT_LOCALE: Locale = "en";

export const SUPPORTED_LOCALE_CODES: ReadonlyArray<Locale> = SUPPORTED_LOCALES.map((l) => l.code);

export function isSupportedLocale(code: unknown): code is Locale {
  return (
    typeof code === "string" && (SUPPORTED_LOCALE_CODES as ReadonlyArray<string>).includes(code)
  );
}
