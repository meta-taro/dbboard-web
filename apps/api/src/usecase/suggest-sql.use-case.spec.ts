import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import { AiUnknownProviderError } from "../domain/ai/ai-provider-registry.port";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type StreamEvent,
  type SuggestRequest,
} from "../domain/ai/ai-provider.port";
import { StaticAiProviderRegistry } from "../infrastructure/static-ai-provider-registry";
import { RecordHistory } from "./record-history.use-case";
import { SuggestSql } from "./suggest-sql.use-case";

// See explain-sql.use-case.spec.ts: the shared recording behaviour is
// covered in record-ai-call.spec.ts, so what is tested here is the
// delegation seam specific to SuggestSql.

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    getId: () => "stub",
    getModel: () => "claude-configured",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: vi.fn(),
    suggestSql: vi.fn(),
    ...overrides,
  };
}

// See explain-sql.use-case.spec.ts — the use case takes a registry now,
// so a single provider is spelled as a one-entry one.
function registryOf(...providers: AiProvider[]): StaticAiProviderRegistry {
  const entries = providers.map((provider, i) => ({
    id: `p${i}`,
    name: `p${i}`,
    kind: "anthropic" as const,
    model: provider.getModel(),
    provider,
  }));
  return new StaticAiProviderRegistry(entries, "p0");
}

function emptyRegistry(): StaticAiProviderRegistry {
  return new StaticAiProviderRegistry([], undefined);
}

function makeHistory(): {
  history: RecordHistory;
  recordAiSuccess: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
} {
  // `record` is exposed as well as the spy: the disabled and
  // unknown-provider paths must write *nothing at all*, and a spy on one
  // of the two recorder methods cannot say that.
  const record = vi.fn(() => Promise.resolve());
  const history = new RecordHistory({
    record,
    // eslint-disable-next-line require-yield
    iterate: async function* () {
      throw new Error("not used in these tests");
    },
  });
  const recordAiSuccess = vi.spyOn(history, "recordAiSuccess") as unknown as ReturnType<
    typeof vi.fn
  >;
  return { history, recordAiSuccess, record };
}

const RESPONSE: AiResponse = {
  text: "SELECT * FROM users;",
  model: "claude-x",
  tokensIn: 10,
  tokensOut: 20,
  stopReason: "end_turn",
};

describe("SuggestSql", () => {
  it("throws AiDisabledError when no provider is configured, and writes nothing", async () => {
    const { history, record } = makeHistory();
    const useCase = new SuggestSql(emptyRegistry(), history);
    await expect(useCase.execute({ prompt: "users by signup date" })).rejects.toBeInstanceOf(
      AiDisabledError,
    );
    // See explain-sql.use-case.spec.ts — the disabled refusal lives in
    // the registry now, so its no-record guarantee is asserted here.
    expect(record).not.toHaveBeenCalled();
  });

  it("delegates to provider.suggestSql with the request verbatim", async () => {
    const { history } = makeHistory();
    const suggestSql = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new SuggestSql(registryOf(makeProvider({ suggestSql })), history);
    const request: SuggestRequest = { prompt: "all users", dialect: "postgres" };

    const result = await useCase.execute(request);

    expect(suggestSql).toHaveBeenCalledExactlyOnceWith(request);
    expect(result).toStrictEqual(RESPONSE);
  });

  it("records the suggest_sql intent with the natural-language prompt", async () => {
    const { history, recordAiSuccess } = makeHistory();
    const suggestSql = vi.fn().mockResolvedValue(RESPONSE);
    const useCase = new SuggestSql(registryOf(makeProvider({ suggestSql })), history);

    await useCase.execute({ prompt: "all users" });

    expect(recordAiSuccess).toHaveBeenCalledOnce();
    expect(recordAiSuccess.mock.calls[0][0]).toMatchObject({
      intent: "suggest_sql",
      prompt: "all users",
    });
  });

  it("wraps a thrown AiError in AiUpstreamError with cause preserved", async () => {
    const { history } = makeHistory();
    const cause = new AiError("upstream went sideways");
    const suggestSql = vi.fn().mockRejectedValue(cause);
    const useCase = new SuggestSql(registryOf(makeProvider({ suggestSql })), history);

    const err = await useCase.execute({ prompt: "x" }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiUpstreamError);
    expect((err as AiUpstreamError).cause).toBe(cause);
  });

  it("lets non-AiError throws bubble untouched (programming bugs, not upstream failures)", async () => {
    const { history } = makeHistory();
    const bug = new TypeError("undefined.foo");
    const suggestSql = vi.fn().mockRejectedValue(bug);
    const useCase = new SuggestSql(registryOf(makeProvider({ suggestSql })), history);

    await expect(useCase.execute({ prompt: "x" })).rejects.toBe(bug);
  });

  describe("provider selection (0032 slice B)", () => {
    it("asks the named provider, not the default", async () => {
      const { history } = makeHistory();
      const first = vi.fn().mockResolvedValue(RESPONSE);
      const second = vi.fn().mockResolvedValue(RESPONSE);
      const useCase = new SuggestSql(
        registryOf(makeProvider({ suggestSql: first }), makeProvider({ suggestSql: second })),
        history,
      );

      await useCase.execute({ prompt: "all users", provider: "p1" });

      expect(first).not.toHaveBeenCalled();
      expect(second).toHaveBeenCalledOnce();
    });

    it("does not pass the provider id down to the provider — it is addressing, not content", async () => {
      const { history } = makeHistory();
      const suggestSql = vi.fn().mockResolvedValue(RESPONSE);
      const useCase = new SuggestSql(registryOf(makeProvider({ suggestSql })), history);

      await useCase.execute({ prompt: "all users", provider: "p0" });

      expect(suggestSql).toHaveBeenCalledExactlyOnceWith({ prompt: "all users" });
    });

    it("rejects an unconfigured name without calling anyone or recording anything", async () => {
      const { history, recordAiSuccess } = makeHistory();
      const suggestSql = vi.fn().mockResolvedValue(RESPONSE);
      const useCase = new SuggestSql(registryOf(makeProvider({ suggestSql })), history);

      await expect(useCase.execute({ prompt: "x", provider: "nope" })).rejects.toBeInstanceOf(
        AiUnknownProviderError,
      );
      expect(suggestSql).not.toHaveBeenCalled();
      expect(recordAiSuccess).not.toHaveBeenCalled();
    });
  });

  describe("stream (0032 slice C)", () => {
    // See explain-sql.use-case.spec.ts for why resolution is asserted to
    // fail before the first read rather than during it.

    it("refuses a disabled deployment before the stream begins, not on first read", () => {
      const { history, record } = makeHistory();
      const useCase = new SuggestSql(emptyRegistry(), history);

      expect(() => useCase.stream({ prompt: "all users" })).toThrow(AiDisabledError);
      expect(record).not.toHaveBeenCalled();
    });

    it("refuses an unconfigured name before the stream begins", () => {
      const { history, record } = makeHistory();
      const useCase = new SuggestSql(registryOf(makeProvider()), history);

      expect(() => useCase.stream({ prompt: "all users", provider: "nope" })).toThrow(
        AiUnknownProviderError,
      );
      expect(record).not.toHaveBeenCalled();
    });

    it("delegates to the provider's own stream, request verbatim and signal attached", async () => {
      const { history } = makeHistory();
      const streamSuggestSql = vi.fn(streamOf({ type: "text_delta", text: "SELECT" }));
      const useCase = new SuggestSql(registryOf(makeProvider({ streamSuggestSql })), history);

      await collect(
        useCase.stream({
          prompt: "all users",
          dialect: "postgres",
          schema: [{ schema: "public", name: "users" }],
          provider: "p0",
        }),
      );

      expect(streamSuggestSql).toHaveBeenCalledExactlyOnceWith(
        {
          prompt: "all users",
          dialect: "postgres",
          schema: [{ schema: "public", name: "users" }],
        },
        { signal: expect.any(AbortSignal) },
      );
    });

    it("falls back to the atomic call when the provider has no stream of its own", async () => {
      const { history } = makeHistory();
      const suggestSql = vi.fn().mockResolvedValue(RESPONSE);
      const useCase = new SuggestSql(registryOf(makeProvider({ suggestSql })), history);

      const events = await collect(useCase.stream({ prompt: "all users" }));

      expect(suggestSql).toHaveBeenCalledExactlyOnceWith({ prompt: "all users" });
      expect(events).toStrictEqual([
        { type: "message_start", tokensIn: 10, model: "claude-x" },
        { type: "text_delta", text: "SELECT * FROM users;" },
        { type: "usage", tokensIn: 10, tokensOut: 20 },
        { type: "message_stop", stopReason: "end_turn" },
      ]);
    });

    it("records the suggest_sql intent with the natural-language prompt", async () => {
      const { history, recordAiSuccess } = makeHistory();
      const streamSuggestSql = vi.fn(streamOf({ type: "message_stop", stopReason: "end_turn" }));
      const useCase = new SuggestSql(registryOf(makeProvider({ streamSuggestSql })), history);

      await collect(useCase.stream({ prompt: "all users" }));

      expect(recordAiSuccess).toHaveBeenCalledOnce();
      expect(recordAiSuccess.mock.calls[0][0]).toMatchObject({
        intent: "suggest_sql",
        prompt: "all users",
      });
    });
  });
});

// See explain-sql.use-case.spec.ts — same two helpers, kept local rather
// than shared so neither spec has to import the other's fixtures.
function streamOf(...events: StreamEvent[]): () => AsyncGenerator<StreamEvent> {
  return async function* () {
    yield* events;
  };
}

async function collect(events: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
  const out: StreamEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}
