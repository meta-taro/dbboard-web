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
        stop_reason: "end_turn",
        usage: { input_tokens: 12, output_tokens: 34 },
      }),
      ...overrides,
    },
  };
}

// The SDK throws typed errors carrying an HTTP `status`; a transport
// failure throws a bare Error with none. The stub reproduces just that
// distinction.
function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status });
}

describe("AnthropicProvider", () => {
  it("reports id 'anthropic' so a future capabilities surface can identify it", () => {
    expect(new AnthropicProvider(stubClient(), "claude-sonnet-4-6").getId()).toBe("anthropic");
  });

  it("reports the configured model, which the error path needs when no response exists", () => {
    expect(new AnthropicProvider(stubClient(), "claude-sonnet-4-6").getModel()).toBe(
      "claude-sonnet-4-6",
    );
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
        stop_reason: "end_turn",
        usage: { input_tokens: 412, output_tokens: 218 },
      });
      const provider = new AnthropicProvider(stubClient({ create }), "claude-sonnet-4-6");

      const response = await provider.explain({ sql: "SELECT * FROM users", dialect: "postgres" });

      expect(response).toEqual({
        text: "The query selects every row from users.",
        model: "claude-sonnet-4-6-20260120",
        tokensIn: 412,
        tokensOut: 218,
        stopReason: "end_turn",
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

  describe("usage and stop_reason", () => {
    it("passes a canonical stop_reason through unchanged", async () => {
      const provider = new AnthropicProvider(
        stubClient({
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            model: "m",
            stop_reason: "max_tokens",
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
        stopReason: "max_tokens",
      });
    });

    it("wraps an unrecognised stop_reason in the other:<text> escape hatch", async () => {
      // Anthropic adds terminal reasons over time (`pause_turn` and
      // friends). Brief 0008 says tolerate, don't drop — and the escape
      // hatch keeps the raw value legible instead of flattening it to
      // null.
      const provider = new AnthropicProvider(
        stubClient({
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            model: "m",
            stop_reason: "pause_turn",
            usage: { input_tokens: 1, output_tokens: 2 },
          }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
        stopReason: "other:pause_turn",
      });
    });

    it("reports null usage and null stop_reason when the response carries neither", async () => {
      // Null means "not reported". Substituting a zero would be
      // indistinguishable from a measured zero in the history log.
      const provider = new AnthropicProvider(
        stubClient({
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            model: "m",
          }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
        tokensIn: null,
        tokensOut: null,
        stopReason: null,
      });
    });

    it("reports null for a usage field that is present but not a number", async () => {
      const provider = new AnthropicProvider(
        stubClient({
          create: vi.fn().mockResolvedValue({
            content: [{ type: "text", text: "ok" }],
            model: "m",
            usage: { input_tokens: 7, output_tokens: null },
          }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
        tokensIn: 7,
        tokensOut: null,
      });
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

    it("categorises a throw with no HTTP status as network", async () => {
      // Nothing came back, so the request did not reach a decision —
      // DNS, TLS, socket. That is ours-or-the-wire, not the provider
      // rejecting us.
      const provider = new AnthropicProvider(
        stubClient({ create: vi.fn().mockRejectedValue(new Error("ECONNRESET")) }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
        category: "network",
      });
    });

    it("categorises 401 and 403 as configuration, not provider", async () => {
      // An auth rejection is the deployment's key being wrong or
      // unentitled. Filing it under `provider` would point an operator
      // at Anthropic's status page for a problem in their own env.
      for (const status of [401, 403]) {
        const provider = new AnthropicProvider(
          stubClient({ create: vi.fn().mockRejectedValue(httpError(status, "denied")) }),
          "claude-sonnet-4-6",
        );
        await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
          category: "configuration",
        });
      }
    });

    it("categorises other HTTP statuses as provider", async () => {
      for (const status of [429, 500, 529]) {
        const provider = new AnthropicProvider(
          stubClient({ create: vi.fn().mockRejectedValue(httpError(status, "upstream")) }),
          "claude-sonnet-4-6",
        );
        await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
          category: "provider",
        });
      }
    });

    it("categorises an unusable response body as provider", async () => {
      // The call succeeded at the transport layer; what came back was
      // not usable. That is the provider's output, not the network.
      const provider = new AnthropicProvider(
        stubClient({
          create: vi.fn().mockResolvedValue({ content: [], model: "m" }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
        category: "provider",
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
