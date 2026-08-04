import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

// @nuxtjs/i18n pre-compiles imported JSON locale files into vue-i18n message
// AST objects. That is what we want at runtime, but it hides the source schema
// from the parity check. Load the JSON straight off disk so we assert against
// the file as the maintainer wrote it.
const here = dirname(fileURLToPath(import.meta.url));
const localesDir = join(here, "..", "i18n", "locales");
type Bundle = Record<string, unknown>;
function load(code: string): Bundle {
  return JSON.parse(readFileSync(join(localesDir, `${code}.json`), "utf8")) as Bundle;
}

const en = load("en");

// Locale-by-locale comparison: a missing key would be visible as English
// fallback at runtime, but lint can't catch it. This test fails CI the moment
// en grows a key that a translation forgot to mirror.
function collectLeafPaths(value: unknown, prefix = ""): string[] {
  if (value === null || typeof value !== "object") {
    return [prefix];
  }
  const out: string[] = [];
  for (const [k, v] of Object.entries(value as Bundle)) {
    out.push(...collectLeafPaths(v, prefix === "" ? k : `${prefix}.${k}`));
  }
  return out.sort();
}

const enPaths = collectLeafPaths(en);

const locales: ReadonlyArray<readonly [string, Bundle]> = [
  ["ja", load("ja")],
  ["ko", load("ko")],
  ["zh-CN", load("zh-CN")],
  ["zh-TW", load("zh-TW")],
  ["de", load("de")],
  ["fr", load("fr")],
  ["es", load("es")],
  ["pt-BR", load("pt-BR")],
  ["ru", load("ru")],
  ["it", load("it")],
];

describe("locale parity with en", () => {
  it("en exposes the documented key set", () => {
    // Pin: removing a key here is a contract change for downstream UI.
    expect(enPaths).toContain("app.title");
    expect(enPaths).toContain("app.tagline");
    expect(enPaths).toContain("install.button");
    expect(enPaths).toContain("offline.title");
    expect(enPaths).toContain("offline.body");
    expect(enPaths).toContain("offline.hint");
    expect(enPaths).toContain("tables.heading");
    expect(enPaths).toContain("sql.title");
    expect(enPaths).toContain("sql.editor.label");
    expect(enPaths).toContain("sql.run");
    expect(enPaths).toContain("sql.running");
    expect(enPaths).toContain("sql.result.empty");
    expect(enPaths).toContain("sql.result.summary");
    expect(enPaths).toContain("sql.link-from-row");
    expect(enPaths).toContain("history.title");
    expect(enPaths).toContain("history.empty");
    expect(enPaths).toContain("history.refresh");
    expect(enPaths).toContain("history.replay");
    expect(enPaths).toContain("history.status.ok");
    expect(enPaths).toContain("history.status.error");
    expect(enPaths).toContain("history.duration");
    expect(enPaths).toContain("history.error.load");
    expect(enPaths).toContain("schema.heading");
    expect(enPaths).toContain("schema.refresh");
    expect(enPaths).toContain("schema.empty");
    expect(enPaths).toContain("schema.default-schema");
    expect(enPaths).toContain("schema.columns.loading");
    expect(enPaths).toContain("schema.error.load");
    expect(enPaths).toContain("schema.error.columns");
    expect(enPaths).toContain("schema.insert-table");
    expect(enPaths).toContain("schema.insert-column");
    expect(enPaths).toContain("result.affected");
    expect(enPaths).toContain("error.prefix.connection");
    expect(enPaths).toContain("error.prefix.query");
    expect(enPaths).toContain("error.prefix.schema");
    expect(enPaths).toContain("error.prefix.type-conversion");
    expect(enPaths).toContain("error.prefix.capability");
    expect(enPaths).toContain("error.prefix.ai-disabled");
    expect(enPaths).toContain("error.prefix.ai-provider");
    expect(enPaths).toContain("ai.heading");
    expect(enPaths).toContain("ai.section.explain");
    expect(enPaths).toContain("ai.section.suggest");
    expect(enPaths).toContain("ai.dialect.label");
    expect(enPaths).toContain("ai.dialect.placeholder");
    expect(enPaths).toContain("ai.explain.button");
    expect(enPaths).toContain("ai.explain.empty");
    expect(enPaths).toContain("ai.suggest.button");
    expect(enPaths).toContain("ai.suggest.empty");
    expect(enPaths).toContain("ai.suggest.prompt-label");
    expect(enPaths).toContain("ai.suggest.prompt-placeholder");
    expect(enPaths).toContain("ai.suggest.insert");
    expect(enPaths).toContain("ai.response.model");
    expect(enPaths).toContain("ai.state.loading");
    expect(enPaths).toContain("ai.disabled.heading");
    expect(enPaths).toContain("ai.disabled.body");
    expect(enPaths).toContain("result.export.label");
    expect(enPaths).toContain("result.export.copy");
    expect(enPaths).toContain("result.export.download");
    expect(enPaths).toContain("result.export.copied");
    expect(enPaths).toContain("result.export.failed");
    expect(enPaths).toContain("locale-switcher.label");
    expect(enPaths).toContain("theme-switcher.label");
    expect(enPaths).toContain("theme-switcher.option.auto");
    expect(enPaths).toContain("theme-switcher.option.light");
    expect(enPaths).toContain("theme-switcher.option.dark");
  });

  for (const [code, bundle] of locales) {
    it(`${code} mirrors the en key set`, () => {
      expect(collectLeafPaths(bundle)).toEqual(enPaths);
    });

    it(`${code} keeps the ICU placeholders of parameterised messages`, () => {
      const flat = bundle as Record<string, Record<string, string>>;
      expect(String(flat.history.title)).toContain("{count}");
      expect(String(flat.history.duration)).toContain("{ms}");
      expect(String(flat.result.affected)).toContain("{rows}");
      expect(String(flat.ai.response.model)).toContain("{model}");
    });

    it(`${code} fills every leaf with a non-empty string`, () => {
      function check(value: unknown, path: string) {
        if (value === null || typeof value !== "object") {
          expect(typeof value, `${code}:${path} must be a string`).toBe("string");
          expect((value as string).length, `${code}:${path} must be non-empty`).toBeGreaterThan(0);
          return;
        }
        for (const [k, v] of Object.entries(value as Bundle)) {
          check(v, path === "" ? k : `${path}.${k}`);
        }
      }
      check(bundle, "");
    });
  }
});
