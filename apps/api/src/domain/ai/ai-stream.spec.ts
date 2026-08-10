import { describe, expect, it, vi } from "vitest";
import { streamExplain, streamSuggestSql } from "./ai-stream";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type AiStreamOptions,
  type ExplainRequest,
  type StreamEvent,
  type SuggestRequest,
} from "./ai-provider.port";

const ANSWER: AiResponse = {
  text: "SELECT 1 returns one row.",
  model: "claude-sonnet-4-6-20260120",
  tokensIn: 11,
  tokensOut: 7,
  stopReason: "end_turn",
};

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

// A provider that never heard of streaming — the shape every adapter had
// before this slice, and the one a future non-streaming provider will
// still have.
function atomicProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    getId: () => "atomic",
    getModel: () => "claude-sonnet-4-6",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: vi.fn(async () => ANSWER),
    suggestSql: vi.fn(async () => ANSWER),
    ...overrides,
  };
}

function streamingProvider(events: StreamEvent[], seen: { options?: AiStreamOptions }): AiProvider {
  async function* emit(): AsyncGenerator<StreamEvent> {
    for (const event of events) yield event;
  }
  return {
    ...atomicProvider(),
    getId: () => "streaming",
    getCapabilities: () => ({ streaming: true, functionCalling: false }),
    streamExplain: (_request: ExplainRequest, options?: AiStreamOptions) => {
      seen.options = options;
      return emit();
    },
    streamSuggestSql: (_request: SuggestRequest, options?: AiStreamOptions) => {
      seen.options = options;
      return emit();
    },
  };
}

describe("streamExplain", () => {
  it("uses the provider's own stream when it has one", async () => {
    const seen: { options?: AiStreamOptions } = {};
    const provider = streamingProvider(
      [
        { type: "text_delta", text: "one " },
        { type: "text_delta", text: "two" },
      ],
      seen,
    );

    expect(await collect(streamExplain(provider, { sql: "SELECT 1" }))).toEqual([
      { type: "text_delta", text: "one " },
      { type: "text_delta", text: "two" },
    ]);
    expect(provider.explain).not.toHaveBeenCalled();
  });

  it("passes the caller's abort signal through to the override", async () => {
    const seen: { options?: AiStreamOptions } = {};
    const provider = streamingProvider([], seen);
    const controller = new AbortController();

    await collect(streamExplain(provider, { sql: "SELECT 1" }, { signal: controller.signal }));

    expect(seen.options?.signal).toBe(controller.signal);
  });

  // Desktop's default trait bodies (ADR-0026 Decision 2): the atomic
  // answer arrives as one chunk, so a caller that only knows the
  // streaming surface still works against a provider that has none.
  it("delegates to the atomic call when the provider has no stream", async () => {
    const provider = atomicProvider();

    expect(
      await collect(streamExplain(provider, { sql: "SELECT 1", dialect: "postgres" })),
    ).toEqual([
      { type: "message_start", tokensIn: 11, model: "claude-sonnet-4-6-20260120" },
      { type: "text_delta", text: ANSWER.text },
      { type: "usage", tokensIn: 11, tokensOut: 7 },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
    expect(provider.explain).toHaveBeenCalledWith({ sql: "SELECT 1", dialect: "postgres" });
  });

  it("lets the atomic call's failure out rather than turning it into an error event", async () => {
    const boom = new Error("upstream refused");
    const provider = atomicProvider({
      explain: vi.fn(async () => {
        throw boom;
      }),
    });

    await expect(collect(streamExplain(provider, { sql: "SELECT 1" }))).rejects.toBe(boom);
  });
});

describe("streamSuggestSql", () => {
  it("uses the provider's own stream when it has one", async () => {
    const seen: { options?: AiStreamOptions } = {};
    const provider = streamingProvider([{ type: "text_delta", text: "SELECT 1" }], seen);

    expect(await collect(streamSuggestSql(provider, { prompt: "one row" }))).toEqual([
      { type: "text_delta", text: "SELECT 1" },
    ]);
    expect(provider.suggestSql).not.toHaveBeenCalled();
  });

  it("delegates to the atomic call when the provider has no stream", async () => {
    const provider = atomicProvider();
    const request: SuggestRequest = { prompt: "one row", schema: [] };

    expect(await collect(streamSuggestSql(provider, request))).toEqual([
      { type: "message_start", tokensIn: 11, model: "claude-sonnet-4-6-20260120" },
      { type: "text_delta", text: ANSWER.text },
      { type: "usage", tokensIn: 11, tokensOut: 7 },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
    expect(provider.suggestSql).toHaveBeenCalledWith(request);
  });

  // A provider that reports no usage records none. The delegate must not
  // invent a zero: in the history log a fabricated count is
  // indistinguishable from a measured one.
  it("carries unreported token counts through as null", async () => {
    const provider = atomicProvider({
      suggestSql: vi.fn(async () => ({ ...ANSWER, tokensIn: null, tokensOut: null })),
    });

    expect(await collect(streamSuggestSql(provider, { prompt: "one row" }))).toEqual([
      { type: "message_start", tokensIn: null, model: "claude-sonnet-4-6-20260120" },
      { type: "text_delta", text: ANSWER.text },
      { type: "usage", tokensIn: null, tokensOut: null },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
  });
});
