import { describe, expect, it, vi } from "vitest";
import { AiDisabledError } from "../domain/ai/ai-error";
import { AiUnknownProviderError } from "../domain/ai/ai-provider-registry.port";
import { NO_AI_CAPABILITIES, type AiProvider } from "../domain/ai/ai-provider.port";
import { StaticAiProviderRegistry } from "./static-ai-provider-registry";

// Ticket 0032 slice B. The registry is where ADR-0025's two surviving
// rules live: a caller may name who answers, and a name that is not
// configured is an error rather than a quiet substitution (Decision 3,
// "no silent fallback between providers").

function makeProvider(id: string, model: string): AiProvider {
  return {
    getId: () => id,
    getModel: () => model,
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: vi.fn(),
    suggestSql: vi.fn(),
  };
}

const SONNET = makeProvider("anthropic", "claude-sonnet-4-6");
const OPUS = makeProvider("anthropic", "claude-opus-4-8");

function twoEntries() {
  return new StaticAiProviderRegistry(
    [
      {
        id: "sonnet",
        name: "Fast",
        kind: "anthropic",
        model: "claude-sonnet-4-6",
        provider: SONNET,
      },
      { id: "opus", name: "Deep", kind: "anthropic", model: "claude-opus-4-8", provider: OPUS },
    ],
    "opus",
  );
}

describe("StaticAiProviderRegistry", () => {
  describe("with no entries", () => {
    const empty = new StaticAiProviderRegistry([], undefined);

    it("lists nothing", () => {
      expect(empty.list()).toStrictEqual([]);
    });

    // Same error and same message as before this slice existed: a
    // deployment with no key configured must keep answering 404 from
    // both AI routes (CLAUDE.md rule 4).
    it("throws AiDisabledError rather than reporting an unknown provider", () => {
      expect(() => empty.resolve(undefined)).toThrow(AiDisabledError);
      expect(() => empty.resolve("sonnet")).toThrow(AiDisabledError);
    });
  });

  describe("with entries", () => {
    it("describes each one and marks exactly the default", () => {
      expect(twoEntries().list()).toStrictEqual([
        {
          id: "sonnet",
          name: "Fast",
          kind: "anthropic",
          model: "claude-sonnet-4-6",
          default: false,
        },
        { id: "opus", name: "Deep", kind: "anthropic", model: "claude-opus-4-8", default: true },
      ]);
    });

    it("does not expose the provider instances through list()", () => {
      // The descriptor is a wire body. A provider object on it would put
      // a live client — and whatever it was constructed with — one
      // JSON.stringify away from the response.
      for (const descriptor of twoEntries().list()) {
        expect(descriptor).not.toHaveProperty("provider");
      }
    });

    it("resolves an unnamed request to the default", () => {
      expect(twoEntries().resolve(undefined)).toBe(OPUS);
    });

    it("resolves a named request to that provider, default or not", () => {
      expect(twoEntries().resolve("sonnet")).toBe(SONNET);
      expect(twoEntries().resolve("opus")).toBe(OPUS);
    });

    it("rejects an unconfigured name instead of falling back to the default", () => {
      expect(() => twoEntries().resolve("gpt-4o")).toThrow(AiUnknownProviderError);
    });

    it("names the id it was given, and the ones it has", () => {
      // The 422 body is the only diagnostic the caller gets, and a
      // selector out of step with the server is the likeliest cause.
      expect(() => twoEntries().resolve("gpt-4o")).toThrow(/"gpt-4o".*sonnet.*opus/s);
    });

    it("does not match an id by case", () => {
      expect(() => twoEntries().resolve("OPUS")).toThrow(AiUnknownProviderError);
    });
  });

  describe("construction", () => {
    it("rejects a default that names no entry", () => {
      expect(
        () =>
          new StaticAiProviderRegistry(
            [
              {
                id: "sonnet",
                name: "Fast",
                kind: "anthropic",
                model: "claude-sonnet-4-6",
                provider: SONNET,
              },
            ],
            "opus",
          ),
      ).toThrow(/"opus"/);
    });

    it("rejects entries with no default", () => {
      expect(
        () =>
          new StaticAiProviderRegistry(
            [
              {
                id: "sonnet",
                name: "Fast",
                kind: "anthropic",
                model: "claude-sonnet-4-6",
                provider: SONNET,
              },
            ],
            undefined,
          ),
      ).toThrow(/default/i);
    });
  });
});
