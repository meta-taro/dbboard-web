import { beforeEach, describe, expect, it } from "vitest";
import { historyRecordSchema, type HistoryRecord } from "../domain/history-record";
import { CapabilityError, QueryError } from "../domain/errors";
import type { QueryResult } from "../domain/values";
import { InMemoryHistoryStore } from "../infrastructure/in-memory-history-store";
import { RecordHistory, type RecordContext } from "./record-history.use-case";

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

describe("RecordHistory", () => {
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
    const [record] = await snapshot(store);
    expect(record).toMatchObject({
      v: 1,
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
    const [record] = await snapshot(store);
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
    const [record] = await snapshot(store);
    expect(record.rows).toBeNull();
    expect(record.rows_affected).toBeNull();
  });

  it("uses the _default sentinel when no connectionId is given", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordSuccess(
      { sql: "SELECT 1", connectionId: undefined, startTimeMs: clockMs, actor: null },
      selectResult(1),
    );
    const [record] = await snapshot(store);
    expect(record.conn).toBe("_default");
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
    const [record] = await snapshot(store);
    expect(record.actor).toBe("alice@example.com");
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
    const [record] = await snapshot(store);
    expect(record).toMatchObject({
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
    const [record] = await snapshot(store);
    expect(record.error).toEqual({
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
    const [record] = await snapshot(store);
    expect(record.error).toEqual({ category: "query", message: "boom" });
  });

  it("every emitted record passes historyRecordSchema (write-side guard)", async () => {
    const { store, rec } = makeStoreAndUsecase();
    await rec.recordSuccess(
      { sql: "SELECT 1", connectionId: "prod-pg", startTimeMs: clockMs, actor: null },
      selectResult(1),
    );
    await rec.recordError(
      { sql: "X", connectionId: "prod-pg", startTimeMs: clockMs, actor: null },
      new QueryError("nope"),
    );
    for (const record of await snapshot(store)) {
      expect(historyRecordSchema.safeParse(record).success).toBe(true);
    }
  });
});
