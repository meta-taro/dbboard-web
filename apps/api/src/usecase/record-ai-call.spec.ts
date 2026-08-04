import { describe, expect, it, vi } from "vitest";
import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
} from "../domain/ai/ai-provider.port";
import type { HistoryRecord } from "../domain/history-record";
import type { HistoryStore } from "./history-store.port";
import { runRecordedAiCall } from "./record-ai-call";
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

describe("runRecordedAiCall", () => {
  it("throws AiDisabledError and records nothing when no provider is configured", async () => {
    const { store, written } = makeStore();
    const history = new RecordHistory(store, () => CLOCK_START);

    const err = await runRecordedAiCall(
      undefined,
      history,
      { intent: "explain", prompt: "SELECT 1", invoke: vi.fn() },
      () => CLOCK_START,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AiDisabledError);
    // No provider was called, so there is no `provider`/`model` to name
    // and the schema requires both — an absent provider is a deployment
    // fact, not an AI call outcome.
    expect(written).toStrictEqual([]);
  });

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
