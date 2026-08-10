import { describe, expect, it, vi } from "vitest";
import { AiError } from "../domain/ai/ai-error";
import type { StreamEvent } from "../domain/ai/ai-provider.port";
import {
  OpenAiProvider,
  createOpenAiProvider,
  type OpenAiChatRequest,
  type OpenAiHttpResponse,
  type OpenAiStreamOpen,
  type OpenAiTransport,
} from "./openai-provider";

// The same provider-level suite Anthropic has (ticket 0032 DoD 7), run
// against a stubbed transport. Mirroring desktop `crates/dbboard-openai`
// at `b98f7a6` — the three axes that differ from Anthropic are the auth
// header (transport's problem), the system prompt travelling as a
// `role: "system"` message rather than a top-level field, and usage
// arriving as `prompt_tokens` / `completion_tokens`.

class ScriptedTransport implements OpenAiTransport {
  readonly posts: OpenAiChatRequest[] = [];
  readonly streams: { body: OpenAiChatRequest; signal?: AbortSignal }[] = [];

  constructor(
    private readonly reply?: OpenAiHttpResponse | (() => Promise<OpenAiHttpResponse>),
    private readonly opened?: OpenAiStreamOpen | (() => Promise<OpenAiStreamOpen>),
  ) {}

  async post(body: OpenAiChatRequest): Promise<OpenAiHttpResponse> {
    this.posts.push(body);
    if (!this.reply) throw new Error("no atomic reply scripted");
    return typeof this.reply === "function" ? this.reply() : this.reply;
  }

  async stream(
    body: OpenAiChatRequest,
    options?: { signal?: AbortSignal },
  ): Promise<OpenAiStreamOpen> {
    this.streams.push({ body, signal: options?.signal });
    if (!this.opened) throw new Error("no stream scripted");
    return typeof this.opened === "function" ? this.opened() : this.opened;
  }
}

function ok(payload: unknown): OpenAiHttpResponse {
  return { status: 200, body: JSON.stringify(payload) };
}

const COMPLETION = {
  model: "gpt-4o-2024-08-06",
  choices: [
    {
      index: 0,
      message: { role: "assistant", content: "It scans every row of users." },
      finish_reason: "stop",
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
};

function providerOn(reply: OpenAiHttpResponse): {
  provider: OpenAiProvider;
  transport: ScriptedTransport;
} {
  const transport = new ScriptedTransport(reply);
  return { provider: new OpenAiProvider(transport, "gpt-4o"), transport };
}

function providerStreaming(opened: OpenAiStreamOpen | (() => Promise<OpenAiStreamOpen>)): {
  provider: OpenAiProvider;
  transport: ScriptedTransport;
} {
  const transport = new ScriptedTransport(undefined, opened);
  return { provider: new OpenAiProvider(transport, "gpt-4o"), transport };
}

// Re-iterable on purpose: a fixture shared by several cases would
// otherwise be drained by whichever ran first, and the second case would
// see an empty stream instead of the conversation it declared.
function framesOf(...payloads: string[]): OpenAiStreamOpen {
  async function* frames(): AsyncGenerator<string> {
    for (const payload of payloads) yield payload;
  }
  return { ok: true, frames: { [Symbol.asyncIterator]: frames } };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of events) seen.push(event);
  return seen;
}

function chunk(payload: Record<string, unknown>): string {
  return JSON.stringify({ model: "gpt-4o-2024-08-06", ...payload });
}

describe("OpenAiProvider identity", () => {
  it("reports the provider id the registry and history records use", () => {
    expect(providerOn(ok(COMPLETION)).provider.getId()).toBe("openai");
  });

  it("reports the configured model", () => {
    expect(providerOn(ok(COMPLETION)).provider.getModel()).toBe("gpt-4o");
  });

  it("promises streaming and nothing else", () => {
    expect(providerOn(ok(COMPLETION)).provider.getCapabilities()).toEqual({
      streaming: true,
      functionCalling: false,
    });
  });
});

describe("explain", () => {
  it("sends the system prompt as the first message rather than a top-level field", async () => {
    const { provider, transport } = providerOn(ok(COMPLETION));

    await provider.explain({ sql: "SELECT 1", dialect: "postgres" });

    const [body] = transport.posts;
    expect(body.model).toBe("gpt-4o");
    expect(body.messages[0]).toEqual({
      role: "system",
      content: "You are a database expert. Explain SQL queries concisely in plain English.",
    });
    expect(body.messages[1]).toEqual({
      role: "user",
      content: "Dialect: postgres\n\nExplain the following SQL query:\n\nSELECT 1",
    });
    expect(body.messages).toHaveLength(2);
    expect(body).not.toHaveProperty("system");
  });

  it("sends no output cap, so a model that rejects max_tokens still answers", async () => {
    // Desktop's reasoning: gpt-4o accepts `max_tokens`, the o-series and
    // gpt-5 reject it in favour of `max_completion_tokens`. Omitting the
    // cap keeps every model id working, and the system prompt already
    // asks for a short answer.
    const { provider, transport } = providerOn(ok(COMPLETION));

    await provider.explain({ sql: "SELECT 1" });

    expect(transport.posts[0]).not.toHaveProperty("max_tokens");
    expect(transport.posts[0]).not.toHaveProperty("max_completion_tokens");
  });

  it("does not ask for a stream on the atomic path", async () => {
    const { provider, transport } = providerOn(ok(COMPLETION));

    await provider.explain({ sql: "SELECT 1" });

    expect(transport.posts[0].stream).toBeUndefined();
    expect(transport.posts[0].stream_options).toBeUndefined();
  });
});

describe("suggestSql", () => {
  it("puts the introspected tables above the request", async () => {
    const { provider, transport } = providerOn(ok(COMPLETION));

    await provider.suggestSql({
      prompt: "everyone who signed up today",
      dialect: "postgres",
      schema: [{ schema: "public", name: "users" }],
    });

    expect(transport.posts[0].messages[0].content).toContain("Return only the SQL");
    expect(transport.posts[0].messages[1].content).toBe(
      "Tables:\n- public.users\n\nDialect: postgres\n\nRequest: everyone who signed up today",
    );
  });

  it("keeps 'there are none' distinct from 'we did not look'", async () => {
    const { provider, transport } = providerOn(ok(COMPLETION));

    await provider.suggestSql({ prompt: "anything", schema: [] });
    await provider.suggestSql({ prompt: "anything" });

    expect(transport.posts[0].messages[1].content).toBe(
      "Tables:\n(no tables introspected)\n\nRequest: anything",
    );
    expect(transport.posts[1].messages[1].content).toBe("Request: anything");
  });
});

describe("reading the completion", () => {
  it("returns the answer, the served model and both token counts", async () => {
    const { provider } = providerOn(ok(COMPLETION));

    await expect(provider.explain({ sql: "SELECT 1" })).resolves.toEqual({
      text: "It scans every row of users.",
      model: "gpt-4o-2024-08-06",
      tokensIn: 11,
      tokensOut: 7,
      stopReason: "end_turn",
    });
  });

  it("concatenates every choice that carried text", async () => {
    const { provider } = providerOn(
      ok({
        choices: [
          { message: { content: "one " } },
          { message: { content: null } },
          { message: { content: "two" } },
        ],
      }),
    );

    await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({ text: "one two" });
  });

  it("falls back to the configured model when the response names none", async () => {
    const { provider } = providerOn(ok({ choices: [{ message: { content: "hi" } }] }));

    await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
      model: "gpt-4o",
    });
  });

  it("reports null counts rather than zeros when usage is absent", async () => {
    const { provider } = providerOn(ok({ choices: [{ message: { content: "hi" } }] }));

    await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
      tokensIn: null,
      tokensOut: null,
      stopReason: null,
    });
  });

  it("translates OpenAI's finish reasons into the history v:2 vocabulary", async () => {
    const cases: [string, string][] = [
      ["stop", "end_turn"],
      ["length", "max_tokens"],
      ["tool_calls", "tool_use"],
      ["function_call", "tool_use"],
      ["content_filter", "refusal"],
    ];

    for (const [raw, expected] of cases) {
      const { provider } = providerOn(
        ok({ choices: [{ message: { content: "hi" }, finish_reason: raw }] }),
      );
      await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
        stopReason: expected,
      });
    }
  });

  it("keeps an unrecognised finish reason legible through the other: hatch", async () => {
    const { provider } = providerOn(
      // A key that exists on Object.prototype, so a plain-object lookup
      // table would hand back a function here instead of missing.
      ok({ choices: [{ message: { content: "hi" }, finish_reason: "constructor" }] }),
    );

    await expect(provider.explain({ sql: "SELECT 1" })).resolves.toMatchObject({
      stopReason: "other:constructor",
    });
  });

  it("refuses a response with no text in it", async () => {
    const { provider } = providerOn(ok({ choices: [{ message: { content: "" } }] }));

    await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
      message: "OpenAI returned no text content in response",
      category: "provider",
    });
  });
});

describe("error handling", () => {
  it("calls a thrown transport a network failure and keeps the cause", async () => {
    const cause = new Error("socket hang up");
    const transport = new ScriptedTransport(() => Promise.reject(cause));
    const provider = new OpenAiProvider(transport, "gpt-4o");

    await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
      message: "OpenAI provider request failed",
      category: "network",
      cause,
    });
  });

  it("blames the deployment for 401 and 403", async () => {
    for (const status of [401, 403]) {
      const { provider } = providerOn({
        status,
        body: JSON.stringify({ error: { type: "invalid_api_key", message: "bad key" } }),
      });

      await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
        message: `OpenAI API error (status ${status}): [invalid_api_key] bad key`,
        category: "configuration",
      });
    }
  });

  it("blames the provider for every other status", async () => {
    const { provider } = providerOn({
      status: 429,
      body: JSON.stringify({ error: { type: "rate_limit_exceeded", message: "slow down" } }),
    });

    await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
      message: "OpenAI API error (status 429): [rate_limit_exceeded] slow down",
      category: "provider",
    });
  });

  it("shows the raw body when the failure is not the documented envelope", async () => {
    // A gateway in front of the API answers in HTML, and that page is the
    // only clue the operator has.
    const { provider } = providerOn({ status: 502, body: "<html>bad gateway</html>" });

    await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
      message: "OpenAI API error (status 502): <html>bad gateway</html>",
      category: "provider",
    });
  });

  it("caps how much of a hostile body reaches the error", async () => {
    const { provider } = providerOn({ status: 500, body: "x".repeat(4096) });

    await expect(provider.explain({ sql: "SELECT 1" })).rejects.toThrow(
      `OpenAI API error (status 500): ${"x".repeat(2048)}…`,
    );
  });

  it("calls an unparseable 200 the provider's fault, not the network's", async () => {
    const { provider } = providerOn({ status: 200, body: "not json" });

    await expect(provider.explain({ sql: "SELECT 1" })).rejects.toMatchObject({
      message: "OpenAI response was not JSON: not json",
      category: "provider",
    });
  });
});

describe("streaming", () => {
  const FULL = framesOf(
    chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "" } }] }),
    chunk({ choices: [{ index: 0, delta: { content: "It " } }] }),
    chunk({ choices: [{ index: 0, delta: { content: "scans." } }] }),
    chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    chunk({ choices: [], usage: { prompt_tokens: 11, completion_tokens: 7 } }),
    "[DONE]",
  );

  it("asks for a stream and for the usage frame that closes it", async () => {
    const { provider, transport } = providerStreaming(FULL);

    await collect(provider.streamExplain({ sql: "SELECT 1" }));

    expect(transport.streams[0].body.stream).toBe(true);
    expect(transport.streams[0].body.stream_options).toEqual({ include_usage: true });
  });

  it("maps a whole conversation onto the port's events", async () => {
    const { provider } = providerStreaming(FULL);

    await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).resolves.toEqual([
      // No input count up front: OpenAI does not report one until the end,
      // and the model is what web's `message_start` is carrying here.
      { type: "message_start", tokensIn: null, model: "gpt-4o-2024-08-06" },
      { type: "text_delta", text: "It " },
      { type: "text_delta", text: "scans." },
      { type: "usage", tokensIn: 11, tokensOut: 7 },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
  });

  it("carries finish_reason forward to the stop rather than emitting it where it appears", async () => {
    const { provider } = providerStreaming(
      framesOf(
        chunk({ choices: [{ delta: { content: "half" }, finish_reason: "length" }] }),
        "[DONE]",
      ),
    );

    const events = await collect(provider.streamExplain({ sql: "SELECT 1" }));

    expect(events.at(-1)).toEqual({ type: "message_stop", stopReason: "max_tokens" });
  });

  it("stops the same way when the connection ends without the sentinel", async () => {
    const { provider } = providerStreaming(
      framesOf(chunk({ choices: [{ delta: { content: "half" } }] })),
    );

    await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).resolves.toEqual([
      { type: "message_start", tokensIn: null, model: "gpt-4o-2024-08-06" },
      { type: "text_delta", text: "half" },
      { type: "message_stop", stopReason: null },
    ]);
  });

  it("still opens and closes a stream that carried nothing", async () => {
    const { provider } = providerStreaming(framesOf("[DONE]"));

    await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).resolves.toEqual([
      { type: "message_start", tokensIn: null, model: null },
      { type: "message_stop", stopReason: null },
    ]);
  });

  it("sends the suggest prompt on the streaming path too", async () => {
    const { provider, transport } = providerStreaming(FULL);

    await collect(provider.streamSuggestSql({ prompt: "count users", schema: [] }));

    expect(transport.streams[0].body.messages[1].content).toBe(
      "Tables:\n(no tables introspected)\n\nRequest: count users",
    );
  });

  it("hands the caller's abort signal to the transport", async () => {
    const { provider, transport } = providerStreaming(FULL);
    const controller = new AbortController();

    await collect(provider.streamExplain({ sql: "SELECT 1" }, { signal: controller.signal }));

    expect(transport.streams[0].signal).toBe(controller.signal);
  });

  it("closes the frame iterator when the consumer walks away", async () => {
    const closed = vi.fn();
    async function* frames(): AsyncGenerator<string> {
      try {
        yield chunk({ choices: [{ delta: { content: "one" } }] });
        yield chunk({ choices: [{ delta: { content: "two" } }] });
      } finally {
        closed();
      }
    }
    const { provider } = providerStreaming({ ok: true, frames: frames() });

    for await (const event of provider.streamExplain({ sql: "SELECT 1" })) {
      if (event.type === "text_delta") break;
    }

    expect(closed).toHaveBeenCalledOnce();
  });

  it("refuses a stream the API declined to open, with the status categorised", async () => {
    const { provider } = providerStreaming({
      ok: false,
      status: 401,
      body: JSON.stringify({ error: { type: "invalid_api_key", message: "bad key" } }),
    });

    await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).rejects.toMatchObject({
      message: "OpenAI API error (status 401): [invalid_api_key] bad key",
      category: "configuration",
    });
  });

  it("calls a transport that never opened a network failure", async () => {
    const cause = new Error("dns failure");
    const { provider } = providerStreaming(() => Promise.reject(cause));

    await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).rejects.toMatchObject({
      message: "OpenAI provider stream failed",
      category: "network",
      cause,
    });
  });

  it("refuses a malformed chunk instead of skipping it", async () => {
    const { provider } = providerStreaming(framesOf("{oops"));

    await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).rejects.toMatchObject({
      message: "OpenAI streaming: malformed chunk payload: {oops",
      category: "provider",
    });
  });

  it("raises an in-band error frame rather than yielding one", async () => {
    // The port's `error` variant belongs to the wire boundary, where a 200
    // has already gone out; a provider is not that boundary.
    const { provider } = providerStreaming(
      framesOf(JSON.stringify({ error: { type: "server_error", message: "upstream fell over" } })),
    );

    await expect(collect(provider.streamExplain({ sql: "SELECT 1" }))).rejects.toMatchObject({
      message: "[server_error] upstream fell over",
      category: "provider",
    });
  });
});

describe("createOpenAiProvider", () => {
  it("refuses to build without a key", () => {
    expect(() => createOpenAiProvider({ apiKey: "   ", model: "gpt-4o" })).toThrow(AiError);
  });

  it("refuses to build without a model", () => {
    expect(() => createOpenAiProvider({ apiKey: "sk-test", model: "" })).toThrow(AiError);
  });

  it("builds a provider that reports the trimmed model", () => {
    expect(createOpenAiProvider({ apiKey: " sk-test ", model: " gpt-4o " }).getModel()).toBe(
      "gpt-4o",
    );
  });
});
