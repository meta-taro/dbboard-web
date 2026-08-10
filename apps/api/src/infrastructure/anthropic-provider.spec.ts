import { describe, expect, it, vi } from "vitest";
import { AiError } from "../domain/ai/ai-error";
import { NO_AI_CAPABILITIES, type StreamEvent } from "../domain/ai/ai-provider.port";
import {
  AnthropicProvider,
  type AnthropicClient,
  type AnthropicMessageRequest,
  type AnthropicStreamEvent,
} from "./anthropic-provider";

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
      // Required on the slice, so a client that cannot stream cannot be
      // built — `getCapabilities().streaming` would otherwise be able to
      // claim a transport the adapter does not actually have.
      stream: vi.fn(() => {
        throw new Error("this stub was not given a stream");
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

  // `streaming` is a contract, not a hint (ADR-0026 Decision 8): the
  // half of the two-halves test that says "true means a real override
  // exists". The other half — `false` means the delegate — is asserted
  // in domain/ai/ai-stream.spec.ts against a provider without one.
  it("advertises streaming, which it implements, and nothing else", () => {
    expect(new AnthropicProvider(stubClient(), "claude-sonnet-4-6").getCapabilities()).toEqual({
      streaming: true,
      functionCalling: false,
    });
  });

  it("does not advertise the capabilities it has no implementation for", () => {
    const capabilities = new AnthropicProvider(stubClient(), "claude-sonnet-4-6").getCapabilities();
    expect(capabilities.functionCalling).toBe(NO_AI_CAPABILITIES.functionCalling);
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

    // ADR-0028 Decision 8, terse half. Desktop's `build_suggest_request`
    // opens with a `Tables:` block, then the dialect, then the request;
    // these three cases pin the same order and the same three states the
    // block can be in.
    it("renders the table list ahead of the dialect and the request", async () => {
      const create = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "x" }], model: "m" });
      const provider = new AnthropicProvider(stubClient({ create }), "claude-sonnet-4-6");

      await provider.suggestSql({
        prompt: "recent orders",
        dialect: "postgres",
        schema: [
          { schema: "public", name: "users" },
          { schema: null, name: "orders" },
        ],
      });

      const content = (create.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]
        ?.content as string;
      // Qualified when the engine has a schema namespace, bare when it
      // does not — desktop's `qualify`.
      expect(content).toContain("- public.users");
      expect(content).toContain("- orders");
      expect(content.indexOf("Tables:")).toBeLessThan(content.indexOf("Dialect: postgres"));
      expect(content.indexOf("Dialect: postgres")).toBeLessThan(content.indexOf("Request:"));
    });

    it("says the tables were introspected and there were none, when handed an empty list", async () => {
      const create = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "x" }], model: "m" });
      const provider = new AnthropicProvider(stubClient({ create }), "claude-sonnet-4-6");

      await provider.suggestSql({ prompt: "anything", schema: [] });

      const content = (create.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]
        ?.content as string;
      expect(content).toContain("(no tables introspected)");
    });

    it("omits the table block entirely when the caller sent no schema at all", async () => {
      // The distinction desktop cannot draw and web can: `Vec::new()` is
      // "I looked and found none", `undefined` is "I did not look". Only
      // the first may be stated to the model. This also keeps a caller
      // written before the field existed producing the identical prompt.
      const create = vi
        .fn()
        .mockResolvedValue({ content: [{ type: "text", text: "x" }], model: "m" });
      const provider = new AnthropicProvider(stubClient({ create }), "claude-sonnet-4-6");

      await provider.suggestSql({ prompt: "recent orders", dialect: "postgres" });

      const content = (create.mock.calls[0]?.[0] as { messages: { content: string }[] }).messages[0]
        ?.content as string;
      expect(content).not.toContain("Tables:");
      expect(content).toBe("Dialect: postgres\n\nRequest: recent orders");
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

  describe("streaming", () => {
    function streamOf(
      events: AnthropicStreamEvent[],
    ): (
      body: AnthropicMessageRequest,
      options?: { signal?: AbortSignal },
    ) => AsyncIterable<AnthropicStreamEvent> {
      return () => {
        async function* emit(): AsyncGenerator<AnthropicStreamEvent> {
          for (const event of events) yield event;
        }
        return emit();
      };
    }

    async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
      const out: StreamEvent[] = [];
      for await (const event of events) out.push(event);
      return out;
    }

    function providerStreaming(
      events: AnthropicStreamEvent[],
      spy?: ReturnType<typeof vi.fn>,
    ): AnthropicProvider {
      const stream = spy ?? vi.fn(streamOf(events));
      return new AnthropicProvider(stubClient({ stream }), "claude-sonnet-4-6");
    }

    // The Anthropic order: message_start, then blocks, then message_delta
    // (which is where stop_reason and the cumulative output count live),
    // then message_stop.
    const FULL: AnthropicStreamEvent[] = [
      {
        type: "message_start",
        message: { model: "claude-sonnet-4-6-20260120", usage: { input_tokens: 412 } },
      },
      { type: "content_block_start", index: 0 },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "The query " } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "selects." } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 218 } },
      { type: "message_stop" },
    ];

    it("maps a complete Anthropic sequence onto the normalised vocabulary", async () => {
      const events = await collect(providerStreaming(FULL).streamExplain({ sql: "SELECT 1" }));

      expect(events).toEqual([
        { type: "message_start", tokensIn: 412, model: "claude-sonnet-4-6-20260120" },
        { type: "text_delta", text: "The query " },
        { type: "text_delta", text: "selects." },
        { type: "usage", tokensIn: null, tokensOut: 218 },
        { type: "message_stop", stopReason: "end_turn" },
      ]);
    });

    it("sends the same body the atomic call would, and forwards the abort signal", async () => {
      const stream = vi.fn(streamOf(FULL));
      const controller = new AbortController();

      await collect(
        providerStreaming(FULL, stream).streamExplain(
          { sql: "SELECT 1", dialect: "postgres" },
          { signal: controller.signal },
        ),
      );

      expect(stream).toHaveBeenCalledWith(
        {
          model: "claude-sonnet-4-6",
          max_tokens: 1024,
          system: "You are a database expert. Explain SQL queries concisely in plain English.",
          messages: [
            {
              role: "user",
              content: "Dialect: postgres\n\nExplain the following SQL query:\n\nSELECT 1",
            },
          ],
        },
        { signal: controller.signal },
      );
    });

    it("builds the suggest prompt from the schema, as the atomic call does", async () => {
      const stream = vi.fn(streamOf(FULL));

      await collect(
        providerStreaming(FULL, stream).streamSuggestSql({
          prompt: "every user",
          schema: [{ name: "users", schema: "public" }],
        }),
      );

      expect(stream.mock.calls[0]?.[0]).toMatchObject({
        messages: [{ role: "user", content: "Tables:\n- public.users\n\nRequest: every user" }],
      });
    });

    // ADR-0026 Decision 3: the port's vocabulary is normalised, so the
    // delta kinds that carry no user-visible text are dropped at the
    // provider layer rather than travelling to a consumer that would
    // have to know they exist.
    it("drops non-text deltas and tolerates ping and unknown event types", async () => {
      const events = await collect(
        providerStreaming([
          { type: "ping" },
          { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } },
          { type: "ping" },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "thinking_delta", thinking: "…" },
          },
          {
            type: "content_block_delta",
            index: 0,
            delta: { type: "signature_delta", signature: "s" },
          },
          {
            type: "content_block_delta",
            index: 1,
            delta: { type: "input_json_delta", partial_json: "{}" },
          },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } },
          { type: "a_kind_added_after_this_was_written" },
          { type: "message_stop" },
        ]).streamExplain({ sql: "SELECT 1" }),
      );

      expect(events).toEqual([
        { type: "message_start", tokensIn: 1, model: "m" },
        { type: "text_delta", text: "hi" },
        { type: "message_stop", stopReason: null },
      ]);
    });

    // Decision 7: `message_delta.usage.output_tokens` is a running
    // total. Passing it through unchanged is what lets the meter
    // replace rather than add — a consumer that summed these would show
    // 60 where the bill says 40.
    it("passes cumulative output counts through without accumulating them", async () => {
      const events = await collect(
        providerStreaming([
          { type: "message_start", message: { model: "m", usage: { input_tokens: 5 } } },
          { type: "message_delta", delta: {}, usage: { output_tokens: 20 } },
          {
            type: "message_delta",
            delta: { stop_reason: "end_turn" },
            usage: { output_tokens: 40 },
          },
          { type: "message_stop" },
        ]).streamExplain({ sql: "SELECT 1" }),
      );

      expect(events.filter((e) => e.type === "usage")).toEqual([
        { type: "usage", tokensIn: null, tokensOut: 20 },
        { type: "usage", tokensIn: null, tokensOut: 40 },
      ]);
    });

    // stop_reason arrives on message_delta but belongs to the terminus,
    // so the adapter carries the last one seen to message_stop.
    it("normalises an unrecognised stop reason through the other: escape hatch", async () => {
      const events = await collect(
        providerStreaming([
          { type: "message_delta", delta: { stop_reason: "model_context_window_exceeded" } },
          { type: "message_stop" },
        ]).streamExplain({ sql: "SELECT 1" }),
      );

      expect(events).toEqual([
        { type: "message_stop", stopReason: "other:model_context_window_exceeded" },
      ]);
    });

    it("reports a mid-stream error event as a provider failure", async () => {
      // ADR-0026: an in-band `error` event is an upstream failure. It is
      // thrown rather than yielded so that every failure — transport,
      // in-band, or unusable body — reaches the recorder by one path.
      const stream = providerStreaming([
        { type: "message_start", message: { model: "m", usage: { input_tokens: 1 } } },
        { type: "error", error: { type: "overloaded_error", message: "Overloaded" } },
      ]).streamExplain({ sql: "SELECT 1" });

      await expect(collect(stream)).rejects.toMatchObject({
        name: "AiError",
        category: "provider",
      });
    });

    it("categorises a failure to open the stream exactly as the atomic call does", async () => {
      const unauthorised = new AnthropicProvider(
        stubClient({
          stream: vi.fn(() => {
            throw httpError(401, "invalid x-api-key");
          }),
        }),
        "claude-sonnet-4-6",
      );
      const offline = new AnthropicProvider(
        stubClient({
          stream: vi.fn(() => {
            throw new Error("socket hang up");
          }),
        }),
        "claude-sonnet-4-6",
      );

      await expect(collect(unauthorised.streamExplain({ sql: "SELECT 1" }))).rejects.toMatchObject({
        category: "configuration",
      });
      await expect(collect(offline.streamExplain({ sql: "SELECT 1" }))).rejects.toMatchObject({
        category: "network",
      });
    });

    it("wraps a failure that arrives after the first event", async () => {
      async function* halfway(): AsyncGenerator<AnthropicStreamEvent> {
        yield { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hi" } };
        throw new Error("connection reset");
      }
      const provider = new AnthropicProvider(
        stubClient({ stream: vi.fn(() => halfway()) }),
        "claude-sonnet-4-6",
      );

      await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).rejects.toBeInstanceOf(
        AiError,
      );
    });
  });
});
