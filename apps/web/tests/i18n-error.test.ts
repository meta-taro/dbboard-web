import { describe, expect, it } from "vitest";
import { parseError, toI18nKey } from "../app/composables/internal/i18n-error";

// Phase 6 Slice 3 (ticket 0022) — closes the latent defect introduced by
// Slice 2: the API ErrorCategory was widened with `ai_disabled` and
// `ai_provider` for the new /ai/* routes, but the web-side bridge was
// not back-propagated. parseError silently accepts the new categories
// at runtime (cast), but toI18nKey then emits the literal underscore
// key, which has no entry in any locale bundle. These tests pin the
// hyphen mapping.

describe("toI18nKey", () => {
  it.each([
    ["connection", "error.prefix.connection"],
    ["query", "error.prefix.query"],
    ["schema", "error.prefix.schema"],
    ["capability", "error.prefix.capability"],
    ["type_conversion", "error.prefix.type-conversion"],
    ["ai_disabled", "error.prefix.ai-disabled"],
    ["ai_provider", "error.prefix.ai-provider"],
  ] as const)("maps %s → %s", (category, key) => {
    expect(toI18nKey(category)).toBe(key);
  });
});

describe("parseError", () => {
  it("preserves ai_disabled category + emits the hyphen i18n key", () => {
    const err = {
      data: {
        error: {
          category: "ai_disabled",
          message: "AI provider is not configured",
        },
      },
    };
    const result = parseError(err);
    expect(result.category).toBe("ai_disabled");
    expect(result.i18nKey).toBe("error.prefix.ai-disabled");
    expect(result.message).toBe("AI provider is not configured");
  });

  it("preserves ai_provider category + emits the hyphen i18n key", () => {
    const err = {
      data: {
        error: {
          category: "ai_provider",
          message: "Upstream model returned 503",
        },
      },
    };
    const result = parseError(err);
    expect(result.category).toBe("ai_provider");
    expect(result.i18nKey).toBe("error.prefix.ai-provider");
  });
});
