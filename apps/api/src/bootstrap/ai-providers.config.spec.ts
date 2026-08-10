import { describe, expect, it } from "vitest";
import { readAiProvidersConfig } from "./ai-providers.config";

// Ticket 0032 slice B. Desktop keeps its provider list in
// `ai-providers.toml` and its keys in the OS keychain (ADR-0025
// Decisions 1–2); web has neither, so the list is read from the
// environment. What is mirrored is the *shape* — several entries, each
// with an id / kind / model, and one of them the default — plus
// ADR-0025's parse posture: duplicate id, unknown kind and a dangling
// default are hard errors, never a quiet skip.
//
// The reader takes the environment as an argument rather than reading
// `process.env` at import time. Every case below is a different
// environment, and module-level reads would mean `vi.resetModules()`
// around each one (see config.spec.ts, which has to).

const KEY = "sk-ant-fixture";

describe("readAiProvidersConfig", () => {
  describe("nothing configured", () => {
    it("returns no entries and no default", () => {
      expect(readAiProvidersConfig({})).toStrictEqual({ entries: [], defaultId: undefined });
    });

    it("treats a blank legacy key as unset, so AI stays off", () => {
      expect(readAiProvidersConfig({ DBBOARD_ANTHROPIC_API_KEY: "" }).entries).toStrictEqual([]);
    });
  });

  describe("the legacy single-provider block", () => {
    // Stage 1's two variables must keep working untouched — desktop
    // ADR-0025 Decision 3 gives the env var highest precedence for the
    // same reason: an existing deployment sees no change.
    it("becomes one entry with the id 'anthropic', and that entry is the default", () => {
      expect(readAiProvidersConfig({ DBBOARD_ANTHROPIC_API_KEY: KEY })).toStrictEqual({
        entries: [
          {
            id: "anthropic",
            name: "anthropic",
            kind: "anthropic",
            model: "claude-sonnet-4-6",
            apiKey: KEY,
          },
        ],
        defaultId: "anthropic",
      });
    });

    it("honours DBBOARD_ANTHROPIC_MODEL as that entry's model", () => {
      const { entries } = readAiProvidersConfig({
        DBBOARD_ANTHROPIC_API_KEY: KEY,
        DBBOARD_ANTHROPIC_MODEL: "claude-opus-4-8",
      });
      expect(entries[0]?.model).toBe("claude-opus-4-8");
    });

    it("falls back to the kind default when DBBOARD_ANTHROPIC_MODEL is blank", () => {
      const { entries } = readAiProvidersConfig({
        DBBOARD_ANTHROPIC_API_KEY: KEY,
        DBBOARD_ANTHROPIC_MODEL: "",
      });
      expect(entries[0]?.model).toBe("claude-sonnet-4-6");
    });
  });

  describe("the enumerated list", () => {
    const TWO = {
      DBBOARD_AI_PROVIDERS: "sonnet,opus",
      DBBOARD_AI_SONNET_KIND: "anthropic",
      DBBOARD_AI_SONNET_API_KEY: "sk-sonnet",
      DBBOARD_AI_OPUS_KIND: "anthropic",
      DBBOARD_AI_OPUS_MODEL: "claude-opus-4-8",
      DBBOARD_AI_OPUS_API_KEY: "sk-opus",
    };

    it("reads every listed id, in the order listed", () => {
      expect(readAiProvidersConfig(TWO).entries).toStrictEqual([
        {
          id: "sonnet",
          name: "sonnet",
          kind: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-sonnet",
        },
        {
          id: "opus",
          name: "opus",
          kind: "anthropic",
          model: "claude-opus-4-8",
          apiKey: "sk-opus",
        },
      ]);
    });

    it("defaults to the first listed id when DBBOARD_AI_DEFAULT is unset", () => {
      expect(readAiProvidersConfig(TWO).defaultId).toBe("sonnet");
    });

    it("honours DBBOARD_AI_DEFAULT", () => {
      expect(readAiProvidersConfig({ ...TWO, DBBOARD_AI_DEFAULT: "opus" }).defaultId).toBe("opus");
    });

    it("takes the display name from DBBOARD_AI_<ID>_NAME when set", () => {
      const { entries } = readAiProvidersConfig({ ...TWO, DBBOARD_AI_OPUS_NAME: "Deep thinking" });
      expect(entries[1]?.name).toBe("Deep thinking");
    });

    it("ignores empty segments and surrounding whitespace in the list", () => {
      const { entries } = readAiProvidersConfig({
        ...TWO,
        DBBOARD_AI_PROVIDERS: " sonnet , ,opus,",
      });
      expect(entries.map((e) => e.id)).toStrictEqual(["sonnet", "opus"]);
    });

    it("maps a hyphenated id to an underscored variable suffix", () => {
      const { entries } = readAiProvidersConfig({
        DBBOARD_AI_PROVIDERS: "big-model",
        DBBOARD_AI_BIG_MODEL_KIND: "anthropic",
        DBBOARD_AI_BIG_MODEL_API_KEY: "sk-big",
      });
      expect(entries).toStrictEqual([
        {
          id: "big-model",
          name: "big-model",
          kind: "anthropic",
          model: "claude-sonnet-4-6",
          apiKey: "sk-big",
        },
      ]);
    });
  });

  describe("legacy and list together", () => {
    const BOTH = {
      DBBOARD_ANTHROPIC_API_KEY: KEY,
      DBBOARD_AI_PROVIDERS: "opus",
      DBBOARD_AI_OPUS_KIND: "anthropic",
      DBBOARD_AI_OPUS_API_KEY: "sk-opus",
    };

    it("keeps both, with the legacy entry first", () => {
      expect(readAiProvidersConfig(BOTH).entries.map((e) => e.id)).toStrictEqual([
        "anthropic",
        "opus",
      ]);
    });

    it("leaves the legacy entry as the default, preserving what that deployment did before", () => {
      expect(readAiProvidersConfig(BOTH).defaultId).toBe("anthropic");
    });

    it("still lets DBBOARD_AI_DEFAULT name the other one", () => {
      expect(readAiProvidersConfig({ ...BOTH, DBBOARD_AI_DEFAULT: "opus" }).defaultId).toBe("opus");
    });
  });

  describe("hard errors", () => {
    // Every message below has to name the offending id or value: the
    // operator is looking at a shell, not a stack trace, and "invalid AI
    // configuration" would send them reading all six variables.
    it("rejects a duplicate id inside the list", () => {
      expect(() =>
        readAiProvidersConfig({
          DBBOARD_AI_PROVIDERS: "opus,opus",
          DBBOARD_AI_OPUS_KIND: "anthropic",
          DBBOARD_AI_OPUS_API_KEY: "sk-opus",
        }),
      ).toThrow(/duplicate.*"opus"/i);
    });

    it("rejects a listed id that collides with the legacy entry", () => {
      expect(() =>
        readAiProvidersConfig({
          DBBOARD_ANTHROPIC_API_KEY: KEY,
          DBBOARD_AI_PROVIDERS: "anthropic",
          DBBOARD_AI_ANTHROPIC_KIND: "anthropic",
          DBBOARD_AI_ANTHROPIC_API_KEY: "sk-other",
        }),
      ).toThrow(/duplicate.*"anthropic"/i);
    });

    it("rejects an id outside [a-z0-9-], because the suffix mapping would stop being reversible", () => {
      expect(() => readAiProvidersConfig({ DBBOARD_AI_PROVIDERS: "Sonnet_1" })).toThrow(
        /"Sonnet_1"/,
      );
    });

    it("rejects a listed id with no kind", () => {
      expect(() =>
        readAiProvidersConfig({
          DBBOARD_AI_PROVIDERS: "opus",
          DBBOARD_AI_OPUS_API_KEY: "sk-opus",
        }),
      ).toThrow(/DBBOARD_AI_OPUS_KIND/);
    });

    it("rejects an unknown kind, naming both the kind and the id", () => {
      expect(() =>
        readAiProvidersConfig({
          DBBOARD_AI_PROVIDERS: "local",
          DBBOARD_AI_LOCAL_KIND: "ollama",
          DBBOARD_AI_LOCAL_API_KEY: "sk-local",
        }),
      ).toThrow(/"ollama".*"local"|"local".*"ollama"/);
    });

    it("rejects a listed id with no key — a provider that cannot answer is not a provider", () => {
      expect(() =>
        readAiProvidersConfig({
          DBBOARD_AI_PROVIDERS: "opus",
          DBBOARD_AI_OPUS_KIND: "anthropic",
        }),
      ).toThrow(/DBBOARD_AI_OPUS_API_KEY/);
    });

    it("treats a blank key the same as a missing one", () => {
      expect(() =>
        readAiProvidersConfig({
          DBBOARD_AI_PROVIDERS: "opus",
          DBBOARD_AI_OPUS_KIND: "anthropic",
          DBBOARD_AI_OPUS_API_KEY: "",
        }),
      ).toThrow(/DBBOARD_AI_OPUS_API_KEY/);
    });

    it("rejects a DBBOARD_AI_DEFAULT that names nothing configured", () => {
      expect(() =>
        readAiProvidersConfig({
          DBBOARD_ANTHROPIC_API_KEY: KEY,
          DBBOARD_AI_DEFAULT: "opus",
        }),
      ).toThrow(/DBBOARD_AI_DEFAULT.*"opus"/);
    });

    it("rejects a DBBOARD_AI_DEFAULT when nothing at all is configured", () => {
      expect(() => readAiProvidersConfig({ DBBOARD_AI_DEFAULT: "opus" })).toThrow(
        /DBBOARD_AI_DEFAULT.*"opus"/,
      );
    });
  });

  describe("what the error must not contain", () => {
    // An operator pastes a startup failure into an issue. If the message
    // quotes the environment back at them, the key goes with it.
    it("never echoes a key value", () => {
      let message = "";
      try {
        readAiProvidersConfig({
          DBBOARD_AI_PROVIDERS: "local",
          DBBOARD_AI_LOCAL_KIND: "ollama",
          DBBOARD_AI_LOCAL_API_KEY: "sk-secret-value",
        });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toBe("");
      expect(message).not.toContain("sk-secret-value");
    });
  });
});
