import { describe, expect, it, vi } from "vitest";
import { AiError } from "../domain/ai/ai-error";
import { NO_AI_CAPABILITIES } from "../domain/ai/ai-provider.port";
import { AnthropicProvider, type AnthropicClient } from "./anthropic-provider";

// The adapter takes a narrow `AnthropicClient` instead of the real
// `Anthropic` instance so these tests can inject a stub without any
// network involved. Production wraps the real SDK; the structural
// match is enforced at the wiring seam (app.module.ts).
function stubClient(overrides: Partial<AnthropicClient["messages"]> = {}): AnthropicClient {
  return {
    messages: {
      create: vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "ok" }],
        model: "claude-sonnet-4-6-20260120",
      }),
      ...overrides,
    },
  };
}

describe("AnthropicProvider", () => {
  it("reports id 'anthropic' so a future capabilities surface can identify it", () => {
    expect(new AnthropicProvider(stubClient(), "claude-sonnet-4-6").getId()).toBe("anthropic");
  });

  it("advertises every capability as false (Stage 1 baseline mirrors desktop)", () => {
    expect(new AnthropicProvider(stubClient(), "claude-sonnet-4-6").getCapabilities()).toEqual(
      NO_AI_CAPABILITIES,
    );
  });

  describe("explain", () => {
    it("sends a single Messages request with the configured model and returns text + served model", async () => {
      const create = vi.fn().mockResolvedValue({
        content: [{ type: "text", text: "The query selects every row from users." }],
        model: "claude-sonnet-4-6-20260120",
      });
      const provider = new AnthropicProvider(stubClient({ create }), "claude-sonnet-4-6");

      const response = await provider.explain({ sql: "SELECT * FROM users", dialect: "postgres" });

      expect(response).toEqual({
        text: "The query selects every row from users.",
        model: "claude-sonnet-4-6-20260120",
      });
      const body = create.mock.calls[0]?.[0] as {
        model: string;
        messages: { role: string; content: string }[];
        max_tokens: number;
      };
      expect(body.model).toBe("claude-sonnet-4-6");
      expect(body.max_tokens).toBeGreaterThan(0);
      expect(body.messages).toHaveLength(1);
      expect(body.messages[0]?.role).toBe("user");
      expect(body.messages[0]?.content).toContain("SELECT * FROM users");
      expect(body.messages[0]?.content).toContain("postgres");
    });

    it("works without a dialect hint", async () => {
      const provider = new AnthropicProvider(stubClient(), "claude-sonnet-4-6");
      await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({ text: "ok" });
    });
  });

  describe("suggestSql", () => {
    it("sends the natural-language prompt to the model and returns the text", async () => {
      const create = vi.fn().mockResolvedValue({
        content: [
          {
            type: "text",
            text: "SELECT email FROM users WHERE created_at > now() - interval '7 days';",
          },
        ],
        model: "claude-sonnet-4-6-20260120",
      });
      const provider = new AnthropicProvider(stubClient({ create }), "claude-sonnet-4-6");

      const response = await provider.suggestSql({
        prompt: "List emails of users that signed up in the last week",
        dialect: "postgres",
      });

      expect(response.text).toContain("SELECT email FROM users");
      const body = create.mock.calls[0]?.[0] as {
        messages: { content: string }[];
      };
      expect(body.messages[0]?.content).toContain("List emails of users");
    });
  });

  describe("error handling", () => {
    it("wraps upstream SDK throws in AiError and preserves the cause", async () => {
      const upstream = new Error("401 Unauthorized");
      const provider = new AnthropicProvider(
        stubClient({ create: vi.fn().mockRejectedValue(upstream) }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
        name: "AiError",
        cause: upstream,
      });
    });

    it("throws AiError when the response contains no text block", async () => {
      const provider = new AnthropicProvider(
        stubClient({
          create: vi.fn().mockResolvedValue({
            content: [],
            model: "claude-sonnet-4-6-20260120",
          }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(provider.suggestSql({ prompt: "anything" })).rejects.toBeInstanceOf(AiError);
    });

    it("throws AiError when the only content block is non-text (e.g. tool_use)", async () => {
      const provider = new AnthropicProvider(
        stubClient({
          create: vi.fn().mockResolvedValue({
            content: [{ type: "tool_use" }],
            model: "claude-sonnet-4-6-20260120",
          }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).rejects.toBeInstanceOf(AiError);
    });
  });
});
