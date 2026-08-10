import { beforeEach, describe, expect, it } from "vitest";
import {
  AI_TEXT_CAP_BYTES,
  AI_TEXT_TRUNCATED_MARKER,
  historyRecordSchema,
  truncateForPersistence,
  type HistoryAiRecord,
  type HistoryQueryRecord,
  type HistoryRecord,
} from "../domain/history-record";
import { AiError } from "../domain/ai/ai-error";
import { CapabilityError, QueryError } from "../domain/errors";
import type { QueryResult } from "../domain/values";
import { InMemoryHistoryStore } from "../infrastructure/in-memory-history-store";
import {
  RecordHistory,
  type AiOutcome,
  type AiRecordContext,
  type RecordContext,
} from "./record-history.use-case";

let clockMs = 1_780_000_000_000; // arbitrary fixed epoch
const nowMs = () => clockMs;

function makeStoreAndUsecase(): { store: InMemoryHistoryStore; rec: RecordHistory } {
  const store = new InMemoryHistoryStore();
  const rec = new RecordHistory(store, nowMs);
  return { store, rec };
}

async function snapshot(store: InMemoryHistoryStore): Promise<HistoryRecord[]> {
  const acc: HistoryRecord[] = [];
  for await (const r of store.iterate()) acc.push(r);
  return acc;
}

// The store holds a union; these narrow it and fail loudly rather than
// letting a wrong-kind record slip past a `toMatchObject` that happens
// to hold for both shapes.
function asQuery(record: HistoryRecord | undefined): HistoryQueryRecord {
  if (record?.kind !== "query") {
    throw new Error(`expected a query record, got ${String(record?.kind)}`);
  }
  return record;
}

function asAi(record: HistoryRecord | undefined): HistoryAiRecord {
  if (record?.kind !== "ai") {
    throw new Error(`expected an ai record, got ${String(record?.kind)}`);
  }
  return record;
}

function selectResult(rows: number): QueryResult {
  return {
    columns: [{ name: "one", declared_type: null }],
    rows: Array.from({ length: rows }, () => [1]),
    rows_affected: 0,
  };
}

function dmlResult(rowsAffected: number): QueryResult {
  return { columns: [], rows: [], rows_affected: rowsAffected };
}

function ddlResult(): QueryResult {
  return { columns: [], rows: [], rows_affected: 0 };
}

function aiCtx(overrides: Partial<AiRecordContext> = {}): AiRecordContext {
  return {
    intent: "explain",
    prompt: "SELECT * FROM users",
    connectionId: null,
    startTimeMs: clockMs,
    actor: null,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    ...overrides,
  };
}

function aiOutcome(overrides: Partial<AiOutcome> = {}): AiOutcome {
  return {
    response: "It reads every column of users.",
    tokensIn: 412,
    tokensOut: 218,
    stopReason: "end_turn",
    ...overrides,
  };
}

describe("RecordHistory — query records", () => {
  beforeEach(() => {
    clockMs = 1_780_000_000_000;
  });

  it("records a SELECT-class result with rows populated and rows_affected null", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const ctx: RecordContext = {
      sql: "SELECT 1",
      connectionId: "prod-pg",
      startTimeMs: clockMs,
      actor: null,
    };
    clockMs += 42;
    await rec.recordSuccess(ctx, selectResult(10));
    const record = asQuery((await snapshot(store))[0]);
    expect(record).toMatchObject({
      v: 2,
      kind: "query",
      conn: "prod-pg",
      actor: null,
      sql: "SELECT 1",
      status: "ok",
      duration_ms: 42,
      rows: 10,
      rows_affected: null,
      error: null,
    });
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("records a DML result with rows null and rows_affected populated", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const ctx: RecordContext = {
      sql: "UPDATE users SET x = 1",
      connectionId: "prod-pg",
      startTimeMs: clockMs,
      actor: null,
    };
    await rec.recordSuccess(ctx, dmlResult(3));
    const record = asQuery((await snapshot(store))[0]);
    expect(record.rows).toBeNull();
    expect(record.rows_affected).toBe(3);
  });

  it("records a DDL result with both rows and rows_affected null", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const ctx: RecordContext = {
      sql: "CREATE TABLE t (x INT)",
      connectionId: "prod-pg",
      startTimeMs: clockMs,
      actor: null,
    };
    await rec.recordSuccess(ctx, ddlResult());
    const record = asQuery((await snapshot(store))[0]);
    expect(record.rows).toBeNull();
    expect(record.rows_affected).toBeNull();
  });

  it("uses the _default sentinel when no connectionId is given", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordSuccess(
      { sql: "SELECT 1", connectionId: undefined, startTimeMs: clockMs, actor: null },
      selectResult(1),
    );
    expect(asQuery((await snapshot(store))[0]).conn).toBe("_default");
  });

  it("preserves the authenticated actor when present", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordSuccess(
      {
        sql: "SELECT 1",
        connectionId: "prod-pg",
        startTimeMs: clockMs,
        actor: "alice@example.com",
      },
      selectResult(1),
    );
    expect(asQuery((await snapshot(store))[0]).actor).toBe("alice@example.com");
  });

  it("records a CategorizedError as status=error with its category", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const ctx: RecordContext = {
      sql: "SELECT 1/0",
      connectionId: "prod-pg",
      startTimeMs: clockMs,
      actor: null,
    };
    clockMs += 7;
    await rec.recordError(ctx, new QueryError("division by zero"));
    expect(asQuery((await snapshot(store))[0])).toMatchObject({
      status: "error",
      duration_ms: 7,
      rows: null,
      rows_affected: null,
      error: { category: "query", message: "division by zero" },
    });
  });

  it("records a CapabilityError with the capability category", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordError(
      { sql: "SELECT 1", connectionId: "missing", startTimeMs: clockMs, actor: null },
      new CapabilityError("unknown connection: missing"),
    );
    expect(asQuery((await snapshot(store))[0]).error).toEqual({
      category: "capability",
      message: "unknown connection: missing",
    });
  });

  it("falls back to category=query for an uncategorized Error", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordError(
      { sql: "SELECT 1", connectionId: "prod-pg", startTimeMs: clockMs, actor: null },
      new Error("boom"),
    );
    expect(asQuery((await snapshot(store))[0]).error).toEqual({
      category: "query",
      message: "boom",
    });
  });
});

describe("RecordHistory — ai records", () => {
  beforeEach(() => {
    clockMs = 1_780_000_000_000;
  });

  it("records a successful explain call", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const ctx = aiCtx();
    clockMs += 4231;
    await rec.recordAiSuccess(ctx, aiOutcome());
    const record = asAi((await snapshot(store))[0]);
    expect(record).toMatchObject({
      v: 2,
      kind: "ai",
      conn: null,
      actor: null,
      intent: "explain",
      prompt: "SELECT * FROM users",
      response: "It reads every column of users.",
      status: "ok",
      duration_ms: 4231,
      tokens_in: 412,
      tokens_out: 218,
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      stop_reason: "end_turn",
      error: null,
    });
    expect(record.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });

  it("records a suggest_sql call under its own intent", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiSuccess(
      aiCtx({ intent: "suggest_sql", prompt: "recent orders" }),
      aiOutcome(),
    );
    expect(asAi((await snapshot(store))[0]).intent).toBe("suggest_sql");
  });

  it("prefers the served model over the requested one when they differ", async () => {
    // An alias like `claude-sonnet-4-6` resolves upstream to a dated
    // build. The record should say which build actually answered.
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiSuccess(aiCtx(), aiOutcome({ servedModel: "claude-sonnet-4-6-20260120" }));
    expect(asAi((await snapshot(store))[0]).model).toBe("claude-sonnet-4-6-20260120");
  });

  it("carries the connection id when the call had DB context", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiSuccess(aiCtx({ connectionId: "prod-pg" }), aiOutcome());
    expect(asAi((await snapshot(store))[0]).conn).toBe("prod-pg");
  });

  it("records null tokens when the provider surfaced no usage", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiSuccess(
      aiCtx(),
      aiOutcome({ tokensIn: null, tokensOut: null, stopReason: null }),
    );
    const record = asAi((await snapshot(store))[0]);
    expect(record.tokens_in).toBeNull();
    expect(record.tokens_out).toBeNull();
    expect(record.stop_reason).toBeNull();
  });

  it("stores the prompt verbatim, including leading and trailing whitespace", async () => {
    // The v:1 stance on `sql` carried forward: no trimming, no
    // normalisation, no redaction (ADR-0027 Decision 8). "Verbatim"
    // is about *content*, not length — Decision 10 still caps the
    // persisted size, which the next two cases cover.
    const { store, rec } = makeStoreAndUsecase();
    const prompt = "  SELECT 1;  \n";
    await rec.recordAiSuccess(aiCtx({ prompt }), aiOutcome());
    expect(asAi((await snapshot(store))[0]).prompt).toBe(prompt);
  });

  it("caps an over-long prompt at the persistence limit (ADR-0027 Decision 10)", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const prompt = "a".repeat(AI_TEXT_CAP_BYTES + 500);
    await rec.recordAiSuccess(aiCtx({ prompt }), aiOutcome());

    const stored = asAi((await snapshot(store))[0]).prompt;
    expect(stored).toBe(truncateForPersistence(prompt));
    expect(stored.endsWith(AI_TEXT_TRUNCATED_MARKER)).toBe(true);
    expect(Buffer.byteLength(stored, "utf8")).toBe(
      AI_TEXT_CAP_BYTES + Buffer.byteLength(AI_TEXT_TRUNCATED_MARKER, "utf8"),
    );
  });

  it("caps an over-long response too, on both the ok and the error path", async () => {
    // The error path matters as much as the success one: a stream that
    // accumulated 200 KiB before failing would otherwise write an
    // unbounded record precisely when things are going wrong.
    const { store, rec } = makeStoreAndUsecase();
    const response = "b".repeat(AI_TEXT_CAP_BYTES + 1);

    await rec.recordAiSuccess(aiCtx(), aiOutcome({ response }));
    await rec.recordAiError(aiCtx(), aiOutcome({ response }), new AiError("boom"));

    const records = (await snapshot(store)).map((r) => asAi(r).response);
    expect(records).toEqual([truncateForPersistence(response), truncateForPersistence(response)]);
    for (const stored of records) {
      expect(stored.endsWith(AI_TEXT_TRUNCATED_MARKER)).toBe(true);
    }
  });

  it("maps an AiError to its own category", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const ctx = aiCtx();
    clockMs += 900;
    await rec.recordAiError(
      ctx,
      aiOutcome({ response: "", tokensIn: null, tokensOut: null, stopReason: null }),
      new AiError("connection reset", { category: "network" }),
    );
    expect(asAi((await snapshot(store))[0])).toMatchObject({
      status: "error",
      duration_ms: 900,
      response: "",
      error: { category: "network", message: "connection reset" },
    });
  });

  it("falls back to category=provider for an uncategorized Error", async () => {
    // The web-side default: an upstream call that failed is the
    // provider's failure unless something proves otherwise.
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiError(aiCtx(), aiOutcome({ response: "" }), new Error("boom"));
    expect(asAi((await snapshot(store))[0]).error).toEqual({
      category: "provider",
      message: "boom",
    });
  });

  it("never writes a DB error category onto an ai record", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiError(aiCtx(), aiOutcome({ response: "" }), new QueryError("wrong taxonomy"));
    expect(asAi((await snapshot(store))[0]).error?.category).toBe("provider");
  });

  it("keeps the partial response on the error path", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiError(
      aiCtx(),
      aiOutcome({ response: "It reads eve" }),
      new AiError("stream died", { category: "network" }),
    );
    expect(asAi((await snapshot(store))[0]).response).toBe("It reads eve");
  });

  // Ticket 0032 slice C. Until streaming existed there was no way for a
  // web AI call to end any way but ok or error, so this writer had no
  // reachable caller; the schema already accepted the status because
  // desktop emits it and web has to read desktop's logs.
  it("records a cancelled stream as its own status rather than an error", async () => {
    const { store, rec } = makeStoreAndUsecase();
    const ctx = aiCtx();
    clockMs += 900;
    await rec.recordAiCancelled(ctx, aiOutcome({ response: "It reads eve" }));
    const record = asAi((await snapshot(store))[0]);
    expect(record).toMatchObject({
      status: "cancelled",
      response: "It reads eve",
      duration_ms: 900,
      // A cancel is not a failure (ADR-0026 Decision 12), so there is
      // nothing to put in the envelope — and the v:2 schema requires
      // exactly that of a cancelled record.
      error: null,
    });
  });

  it("keeps the tokens a cancelled stream actually spent", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordAiCancelled(
      aiCtx(),
      aiOutcome({ tokensIn: 412, tokensOut: 37, stopReason: "other:cancelled" }),
    );
    expect(asAi((await snapshot(store))[0])).toMatchObject({
      tokens_in: 412,
      tokens_out: 37,
      stop_reason: "other:cancelled",
    });
  });
});

describe("RecordHistory — write-side schema guard", () => {
  beforeEach(() => {
    clockMs = 1_780_000_000_000;
  });

  it("every emitted record passes historyRecordSchema", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordSuccess(
      { sql: "SELECT 1", connectionId: "prod-pg", startTimeMs: clockMs, actor: null },
      selectResult(1),
    );
    await rec.recordError(
      { sql: "X", connectionId: "prod-pg", startTimeMs: clockMs, actor: null },
      new QueryError("nope"),
    );
    await rec.recordAiSuccess(aiCtx(), aiOutcome());
    await rec.recordAiError(aiCtx(), aiOutcome({ response: "" }), new AiError("nope"));
    const records = await snapshot(store);
    expect(records).toHaveLength(4);
    for (const record of records) {
      expect(historyRecordSchema.safeParse(record).success).toBe(true);
    }
  });

  it("throws rather than storing a record the schema rejects", async () => {
    // A failed safeParse here is a programmer bug — we own both sides of
    // the mapping — so it must surface loudly instead of corrupting the
    // log. An empty provider id is the cheapest way to trip it.
    const { store, rec } = makeStoreAndUsecase();
    await expect(rec.recordAiSuccess(aiCtx({ provider: "" }), aiOutcome())).rejects.toThrow(
      /failed schema validation/,
    );
    expect(await snapshot(store)).toEqual([]);
  });
});
