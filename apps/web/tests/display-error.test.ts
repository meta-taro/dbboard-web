import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { describe, expect, it } from "vitest";
import {
  displayError,
  errorClipboardText,
  fromCategorised,
  hasOriginal,
  plainError,
  prefixed,
} from "../app/utils/display-error";
import type { CategorisedError } from "../app/composables/internal/i18n-error";

// Read off disk rather than imported: @nuxtjs/i18n compiles locale JSON into
// vue-i18n message AST nodes, so an import would hand us objects, not the
// English sentences. i18n-locale-parity.test.ts does the same, and it makes
// this an independent source — display-error.ts reaches the same file through
// the bundler (`?raw`), so the assertions below check the two agree.
const enPrefixes = (
  JSON.parse(
    readFileSync(
      joinPath(dirname(fileURLToPath(import.meta.url)), "..", "i18n", "locales", "en.json"),
      "utf8",
    ),
  ) as { error: { prefix: Record<string, string> } }
).error.prefix;

// A Japanese `t` for the localized half. Only the prefixes matter here.
const JA: Record<string, string> = {
  "error.prefix.query": "クエリエラー",
  "error.prefix.connection": "接続エラー",
  "error.prefix.capability": "この操作には対応していません",
};
const ja = (key: string) => JA[key] ?? key;
const identity = (key: string) => key;

function categorised(over: Partial<CategorisedError> = {}): CategorisedError {
  return {
    category: "query",
    message: 'relation "users" does not exist',
    i18nKey: "error.prefix.query",
    ...over,
  };
}

describe("displayError", () => {
  it("carries both halves as given", () => {
    const e = displayError("クエリエラー: boom", "Query error: boom");

    expect(e.localized).toBe("クエリエラー: boom");
    expect(e.original).toBe("Query error: boom");
  });

  // Desktop's `plain`: a UI-side validation has no lower layer to have come
  // from, so there is no English original distinct from what is on screen.
  it("gives a plain error two identical halves", () => {
    const e = plainError("Passphrases do not match");

    expect(e.localized).toBe("Passphrases do not match");
    expect(e.original).toBe("Passphrases do not match");
  });
});

describe("hasOriginal", () => {
  it("is true when the two halves differ", () => {
    expect(hasOriginal(displayError("クエリエラー: boom", "Query error: boom"))).toBe(true);
  });

  // An English UI translates to itself. Rendering the same sentence twice
  // reads as a bug, and the second line is meant to add something.
  it("is false when the localized half is already the original", () => {
    expect(hasOriginal(displayError("Query error: boom", "Query error: boom"))).toBe(false);
    expect(hasOriginal(plainError("Passphrases do not match"))).toBe(false);
  });
});

describe("errorClipboardText", () => {
  // The point of the copy button (desktop ADR-0039): paste the English into a
  // search or an assistant. Both halves go, because the localized one is what
  // the user saw and the English one is what is searchable.
  it("joins the two halves with a newline", () => {
    const text = errorClipboardText(displayError("クエリエラー: boom", "Query error: boom"));

    expect(text).toBe("クエリエラー: boom\nQuery error: boom");
  });

  it("does not duplicate a line that is its own original", () => {
    expect(errorClipboardText(plainError("Passphrases do not match"))).toBe(
      "Passphrases do not match",
    );
  });
});

describe("fromCategorised", () => {
  it("localizes the prefix and keeps the body verbatim", () => {
    const e = fromCategorised(categorised(), ja);

    expect(e.localized).toBe('クエリエラー: relation "users" does not exist');
  });

  // ADR-0039's scope boundary, and the reason this slice is not just a
  // translation pass: the body comes from the connection target, not from
  // dbboard, so only the category prefix is ours to translate.
  it("keeps the engine's own wording in both halves", () => {
    const e = fromCategorised(categorised(), ja);

    expect(e.localized).toContain('relation "users" does not exist');
    expect(e.original).toContain('relation "users" does not exist');
  });

  it("builds the original half from the English bundle, not from `t`", () => {
    const e = fromCategorised(categorised(), ja);

    expect(e.original).toBe('Query error: relation "users" does not exist');
    expect(e.original).toContain(enPrefixes.query);
  });

  // The English UI is the case where the second line would be noise.
  it("collapses to one half when the UI is already English", () => {
    const e = fromCategorised(categorised(), enPrefix);

    expect(hasOriginal(e)).toBe(false);
  });

  it("covers every category the wire can send", () => {
    const categories = [
      ["connection", "error.prefix.connection"],
      ["query", "error.prefix.query"],
      ["schema", "error.prefix.schema"],
      ["type_conversion", "error.prefix.type-conversion"],
      ["capability", "error.prefix.capability"],
      ["ai_disabled", "error.prefix.ai-disabled"],
      ["ai_provider", "error.prefix.ai-provider"],
    ] as const;

    for (const [category, key] of categories) {
      const e = fromCategorised(categorised({ category, i18nKey: key, message: "boom" }), identity);
      // A missing English prefix would leave the raw key on screen — the
      // failure mode desktop calls "degrades visibly".
      expect(e.original).not.toContain("error.prefix.");
      expect(e.original).toMatch(/: boom$/);
    }
  });

  // A category the client does not know about must not erase the message.
  // The body is the part with the information; losing it to a lookup miss
  // would be strictly worse than an unlabelled error.
  it("falls back to the body alone for a prefix it cannot resolve", () => {
    const e = fromCategorised(
      categorised({ i18nKey: "error.prefix.not-a-category" as CategorisedError["i18nKey"] }),
      identity,
    );

    expect(e.original).toBe('relation "users" does not exist');
  });
});

describe("prefixed", () => {
  // The schema browser and the history sidebar name their prefix outside the
  // `error.prefix.*` subtree. They still deserve the searchable half.
  it("resolves a key from anywhere in the bundle, not just error.prefix", () => {
    const e = prefixed("schema.error.load", "connection refused", () => "スキーマの読み込みに失敗");

    expect(e.localized).toBe("スキーマの読み込みに失敗: connection refused");
    expect(e.original).toBe("Failed to load schema: connection refused");
  });

  // The columns failure has no sentence from underneath — the client noticed
  // it. A dangling colon would suggest something was lost.
  it("renders the prefix alone when there is no body", () => {
    const e = prefixed("schema.error.columns", null, () => "列を読み込めません");

    expect(e.localized).toBe("列を読み込めません");
    expect(e.original).toBe("Failed to load columns");
    expect(e.original).not.toContain(":");
  });

  // An empty red box says less than a key does. ADR-0039 calls this
  // degrading visibly.
  it("falls back to the key when neither half resolves", () => {
    const e = prefixed("nope.not.a.key", null, (key) => key);

    expect(e.localized).toBe("nope.not.a.key");
    expect(e.original).toBe("nope.not.a.key");
  });

  // A key naming a subtree rather than a message must not stringify to
  // "[object Object]" — the exact failure a plain JSON import produced here.
  it("treats a key that names a subtree as unresolved", () => {
    const e = prefixed("error.prefix", "boom", (key) => key);

    expect(e.original).toBe("boom");
  });
});

function enPrefix(key: string): string {
  const leaf = key.replace("error.prefix.", "");
  return enPrefixes[leaf] ?? key;
}
