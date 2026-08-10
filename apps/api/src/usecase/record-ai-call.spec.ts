import { describe, expect, it, vi } from "vitest";
import { AiError, AiUpstreamError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type AiStreamOptions,
  type StreamEvent,
} from "../domain/ai/ai-provider.port";
import type { HistoryRecord } from "../domain/history-record";
import type { HistoryStore } from "./history-store.port";
import { runRecordedAiCall, runRecordedAiStream } from "./record-ai-call";
import { RecordHistory } from "./record-history.use-case";

// Exercised through the *real* RecordHistory rather than a spy, because
// the invariant worth protecting is the shape of the record that reaches
// the store — a spy on recordAiSuccess would pass even if the mapping
// below it emitted something the v:2 schema rejects.

const CLOCK_START = 1_780_000_000_000;

function makeStore(): { store: HistoryStore; written: HistoryRecord[] } {
  const written: HistoryRecord[] = [];
  return {
    written,
    store: {
      record: async (record) => {
        written.push(record);
      },
      // eslint-disable-next-line require-yield
      iterate: async function* () {
        throw new Error("not used in these tests");
      },
    },
  };
}

function makeProvider(overrides: Partial<AiProvider> = {}): AiProvider {
  return {
    getId: () => "anthropic",
    getModel: () => "claude-configured",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: vi.fn(),
    suggestSql: vi.fn(),
    ...overrides,
  };
}

const RESPONSE: AiResponse = {
  text: "because it scans the whole table",
  model: "claude-served-20260101",
  tokensIn: 120,
  tokensOut: 45,
  stopReason: "end_turn",
};

function asAi(record: HistoryRecord): Extract<HistoryRecord, { kind: "ai" }> {
  if (record.kind !== "ai") throw new Error(`expected an ai record, got ${record.kind}`);
  return record;
}

// "No provider configured" used to be decided here, by a `provider ===
// undefined` branch at the top of runRecordedAiCall. Slice B moved that
// decision into the registry, which is the only thing that knows how many
// providers exist, and this function now receives a resolved provider.
// The guarantee that case carried — AiDisabledError, and nothing written,
// because an absent provider is a deployment fact rather than an AI call
// outcome — is asserted in static-ai-provider-registry.spec.ts (the
// error) and in both use-case specs (the empty history).

describe("runRecordedAiCall", () => {
  it("records a kind:'ai' v:2 success record and returns the response untouched", async () => {
    const { store, written } = makeStore();
    let clock = CLOCK_START;
    const history = new RecordHistory(store, () => clock);
    const invoke = vi.fn().mockImplementation(async () => {
      clock += 850;
      return RESPONSE;
    });

    const result = await runRecordedAiCall(
      makeProvider(),
      history,
      { intent: "explain", prompt: "SELECT * FROM big", invoke },
      () => clock,
    );

    expect(result).toStrictEqual(RESPONSE);
    expect(written).toHaveLength(1);
    expect(asAi(written[0])).toStrictEqual({
      v: 2,
      kind: "ai",
      ts: new Date(CLOCK_START + 850).toISOString(),
      // The AI routes carry no connection and web has no authenticated
      // actor yet.
      conn: null,
      actor: null,
      intent: "explain",
      prompt: "SELECT * FROM big",
      response: RESPONSE.text,
      status: "ok",
      duration_ms: 850,
      tokens_in: 120,
      tokens_out: 45,
      provider: "anthropic",
      // The served build wins over the configured alias.
      model: "claude-served-20260101",
      stop_reason: "end_turn",
      error: null,
    });
  });

  it("carries the suggest_sql intent and its prompt through unchanged", async () => {
    const { store, written } = makeStore();
    const history = new RecordHistory(store, () => CLOCK_START);
    const invoke = vi.fn().mockResolvedValue(RESPONSE);

    await runRecordedAiCall(
      makeProvider(),
      history,
      { intent: "suggest_sql", prompt: "top customers by revenue", invoke },
      () => CLOCK_START,
    );

    const record = asAi(written[0]);
    expect(record.intent).toBe("suggest_sql");
    expect(record.prompt).toBe("top customers by revenue");
  });

  it("records null token counts rather than zeros when the provider reported none", async () => {
    const { store, written } = makeStore();
    const history = new RecordHistory(store, () => CLOCK_START);
    const invoke = vi
      .fn()
      .mockResolvedValue({ ...RESPONSE, tokensIn: null, tokensOut: null, stopReason: null });

    await runRecordedAiCall(
      makeProvider(),
      history,
      { intent: "explain", prompt: "SELECT 1", invoke },
      () => CLOCK_START,
    );

    const record = asAi(written[0]);
    expect(record.tokens_in).toBeNull();
    expect(record.tokens_out).toBeNull();
    expect(record.stop_reason).toBeNull();
  });

  it("records an error record with the AiError's own category, then wraps in AiUpstreamError", async () => {
    const { store, written } = makeStore();
    let clock = CLOCK_START;
    const history = new RecordHistory(store, () => clock);
    const cause = new AiError("bad api key", { category: "configuration" });
    const invoke = vi.fn().mockImplementation(async () => {
      clock += 40;
      throw cause;
    });

    const err = await runRecordedAiCall(
      makeProvider(),
      history,
      { intent: "explain", prompt: "SELECT 1", invoke },
      () => clock,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiUpstreamError);
    expect((err as AiUpstreamError).cause).toBe(cause);

    const record = asAi(written[0]);
    expect(record.status).toBe("error");
    expect(record.error).toStrictEqual({ category: "configuration", message: "bad api key" });
    // No response accumulated: web's AI surface is non-streaming, so a
    // failed call produced no partial text.
    expect(record.response).toBe("");
    expect(record.duration_ms).toBe(40);
    // The error path has no served model, so the configured one stands.
    expect(record.model).toBe("claude-configured");
  });

  it("neither records nor wraps a non-AiError throw", async () => {
    const { store, written } = makeStore();
    const history = new RecordHistory(store, () => CLOCK_START);
    const bug = new TypeError("undefined.foo");
    const invoke = vi.fn().mockRejectedValue(bug);

    await expect(
      runRecordedAiCall(
        makeProvider(),
        history,
        { intent: "explain", prompt: "SELECT 1", invoke },
        () => CLOCK_START,
      ),
    ).rejects.toBe(bug);

    // A TypeError is our own bug, and the three-category taxonomy has no
    // honest slot for it — recording it as "provider" would blame the
    // upstream for a crash in this repo.
    expect(written).toStrictEqual([]);
  });

  it("swallows a throwing recorder so a logging fault cannot fail the request", async () => {
    const history = new RecordHistory(
      {
        record: () => Promise.reject(new Error("disk full")),
        // eslint-disable-next-line require-yield
        iterate: async function* () {
          throw new Error("not used");
        },
      },
      () => CLOCK_START,
    );
    const invoke = vi.fn().mockResolvedValue(RESPONSE);

    const result = await runRecordedAiCall(
      makeProvider(),
      history,
      { intent: "explain", prompt: "SELECT 1", invoke },
      () => CLOCK_START,
    );

    expect(result).toStrictEqual(RESPONSE);
  });

  it("still wraps in AiUpstreamError when recording the failure itself fails", async () => {
    const history = new RecordHistory(
      {
        record: () => Promise.reject(new Error("disk full")),
        // eslint-disable-next-line require-yield
        iterate: async function* () {
          throw new Error("not used");
        },
      },
      () => CLOCK_START,
    );
    const invoke = vi.fn().mockRejectedValue(new AiError("upstream 500"));

    await expect(
      runRecordedAiCall(
        makeProvider(),
        history,
        { intent: "explain", prompt: "SELECT 1", invoke },
        () => CLOCK_START,
      ),
    ).rejects.toBeInstanceOf(AiUpstreamError);
  });
});

describe("runRecordedAiStream", () => {
  function events(
    ...list: StreamEvent[]
  ): (provider: AiProvider, options: AiStreamOptions) => AsyncIterable<StreamEvent> {
    return () => {
      async function* emit(): AsyncGenerator<StreamEvent> {
        for (const event of list) yield event;
      }
      return emit();
    };
  }

  const FULL: StreamEvent[] = [
    { type: "message_start", tokensIn: 120, model: "claude-served-20260101" },
    { type: "text_delta", text: "because it " },
    { type: "text_delta", text: "scans the whole table" },
    { type: "usage", tokensIn: null, tokensOut: 45 },
    { type: "message_stop", stopReason: "end_turn" },
  ];

  function setup() {
    const { store, written } = makeStore();
    const history = new RecordHistory(store, () => CLOCK_START);
    return { written, history };
  }

  async function drain(stream: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> {
    const seen: StreamEvent[] = [];
    for await (const event of stream) seen.push(event);
    return seen;
  }

  it("passes every event through untouched", async () => {
    const { history } = setup();
    const seen = await drain(
      runRecordedAiStream(
        makeProvider(),
        history,
        { intent: "explain", prompt: "SELECT 1", invoke: events(...FULL) },
        () => CLOCK_START,
      ),
    );
    expect(seen).toEqual(FULL);
  });

  it("writes exactly one success record, assembled from the events", async () => {
    const { written, history } = setup();
    await drain(
      runRecordedAiStream(
        makeProvider(),
        history,
        { intent: "explain", prompt: "SELECT 1", invoke: events(...FULL) },
        () => CLOCK_START,
      ),
    );

    expect(written).toHaveLength(1);
    expect(asAi(written[0]!)).toMatchObject({
      kind: "ai",
      intent: "explain",
      prompt: "SELECT 1",
      status: "ok",
      response: "because it scans the whole table",
      tokens_in: 120,
      tokens_out: 45,
      provider: "anthropic",
      // The served build beats the configured alias, exactly as the
      // atomic path resolves it.
      model: "claude-served-20260101",
      stop_reason: "end_turn",
      error: null,
    });
  });

  // ADR-0026 Decision 7. A recorder that added these would log 65 where
  // the invoice says 45.
  it("replaces the token counts on each usage report rather than summing them", async () => {
    const { written, history } = setup();
    await drain(
      runRecordedAiStream(
        makeProvider(),
        history,
        {
          intent: "explain",
          prompt: "SELECT 1",
          invoke: events(
            { type: "message_start", tokensIn: 120, model: "m" },
            { type: "usage", tokensIn: null, tokensOut: 20 },
            { type: "usage", tokensIn: null, tokensOut: 45 },
            { type: "message_stop", stopReason: "end_turn" },
          ),
        },
        () => CLOCK_START,
      ),
    );
    expect(asAi(written[0]!)).toMatchObject({ tokens_in: 120, tokens_out: 45 });
  });

  // Null is "this event reported none", not "none were spent". Letting
  // it overwrite would erase the count message_start already gave us.
  it("leaves a reported count alone when a later event reports null", async () => {
    const { written, history } = setup();
    await drain(
      runRecordedAiStream(
        makeProvider(),
        history,
        {
          intent: "explain",
          prompt: "SELECT 1",
          invoke: events(
            { type: "message_start", tokensIn: 120, model: "m" },
            { type: "usage", tokensIn: null, tokensOut: 45 },
            { type: "message_stop", stopReason: "end_turn" },
          ),
        },
        () => CLOCK_START,
      ),
    );
    expect(asAi(written[0]!)).toMatchObject({ tokens_in: 120, tokens_out: 45 });
  });

  it("records a consumer that walks away as cancelled, with the partial text", async () => {
    const { written, history } = setup();
    const stream = runRecordedAiStream(
      makeProvider(),
      history,
      { intent: "explain", prompt: "SELECT 1", invoke: events(...FULL) },
      () => CLOCK_START,
    );

    for await (const event of stream) {
      if (event.type === "text_delta") break;
    }

    expect(written).toHaveLength(1);
    expect(asAi(written[0]!)).toMatchObject({
      status: "cancelled",
      response: "because it ",
      tokens_in: 120,
      tokens_out: null,
      // No schema change needed: the escape hatch already carries values
      // outside the canonical set.
      stop_reason: "other:cancelled",
      error: null,
    });
  });

  // DoD 3: the point of cancelling is to stop being billed, which means
  // the signal has to reach the transport — abandoning the output while
  // the upstream keeps generating pays for tokens nobody reads.
  it("aborts the signal it handed the provider when the consumer walks away", async () => {
    const { history } = setup();
    let signal: AbortSignal | undefined;
    const stream = runRecordedAiStream(
      makeProvider(),
      history,
      {
        intent: "explain",
        prompt: "SELECT 1",
        invoke: (provider, options) => {
          signal = options.signal;
          return events(...FULL)(provider, options);
        },
      },
      () => CLOCK_START,
    );

    for await (const event of stream) {
      if (event.type === "text_delta") break;
    }

    expect(signal?.aborted).toBe(true);
  });

  it("treats a consumer that stops after message_stop as complete, not cancelled", async () => {
    const { written, history } = setup();
    const stream = runRecordedAiStream(
      makeProvider(),
      history,
      { intent: "explain", prompt: "SELECT 1", invoke: events(...FULL) },
      () => CLOCK_START,
    );

    for await (const event of stream) {
      if (event.type === "message_stop") break;
    }

    expect(asAi(written[0]!).status).toBe("ok");
  });

  it("records an AiError as an error record and rethrows it as AiUpstreamError", async () => {
    const { written, history } = setup();
    async function* failing(): AsyncGenerator<StreamEvent> {
      yield { type: "message_start", tokensIn: 120, model: "m" };
      yield { type: "text_delta", text: "because it " };
      throw new AiError("connection reset", { category: "network" });
    }

    await expect(
      drain(
        runRecordedAiStream(
          makeProvider(),
          history,
          { intent: "explain", prompt: "SELECT 1", invoke: () => failing() },
          () => CLOCK_START,
        ),
      ),
    ).rejects.toBeInstanceOf(AiUpstreamError);

    expect(written).toHaveLength(1);
    expect(asAi(written[0]!)).toMatchObject({
      status: "error",
      // The text that did arrive is real and is kept, same as the atomic
      // error path keeps a partial response.
      response: "because it ",
      error: { category: "network", message: "connection reset" },
    });
  });

  it("records nothing when the failure is our own bug rather than an AI outcome", async () => {
    const { written, history } = setup();
    const bug = new TypeError("cannot read properties of undefined");
    async function* crashing(): AsyncGenerator<StreamEvent> {
      yield { type: "message_start", tokensIn: 1, model: "m" };
      throw bug;
    }

    await expect(
      drain(
        runRecordedAiStream(
          makeProvider(),
          history,
          { intent: "suggest_sql", prompt: "everything", invoke: () => crashing() },
          () => CLOCK_START,
        ),
      ),
    ).rejects.toBe(bug);

    expect(written).toEqual([]);
  });

  it("does not let a broken recorder break the stream", async () => {
    const { store } = makeStore();
    const history = new RecordHistory(store, () => CLOCK_START);
    vi.spyOn(history, "recordAiSuccess").mockRejectedValue(new Error("disk full"));

    await expect(
      drain(
        runRecordedAiStream(
          makeProvider(),
          history,
          { intent: "explain", prompt: "SELECT 1", invoke: events(...FULL) },
          () => CLOCK_START,
        ),
      ),
    ).resolves.toHaveLength(FULL.length);
  });
});
