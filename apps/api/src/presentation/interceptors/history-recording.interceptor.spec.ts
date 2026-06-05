import type { CallHandler, ExecutionContext } from "@nestjs/common";
import { firstValueFrom, of, throwError } from "rxjs";
import { describe, expect, it, vi } from "vitest";
import { QueryError } from "../../domain/errors";
import type { QueryResult } from "../../domain/values";
import { InMemoryHistoryStore } from "../../infrastructure/in-memory-history-store";
import { RecordHistory } from "../../usecase/record-history.use-case";
import { HistoryRecordingInterceptor } from "./history-recording.interceptor";

interface FakeRequest {
  body: { sql: string };
  params: Record<string, string>;
}

function execCtx(req: FakeRequest): ExecutionContext {
  const httpHost = {
    getRequest: <T>() => req as unknown as T,
    getResponse: <T>() => ({}) as T,
    getNext: <T>() => ({}) as T,
  };
  return {
    switchToHttp: () => httpHost,
  } as unknown as ExecutionContext;
}

function selectResult(rows: number): QueryResult {
  return {
    columns: [{ name: "n", declared_type: null }],
    rows: Array.from({ length: rows }, () => [1]),
    rows_affected: 0,
  };
}

async function collect(store: InMemoryHistoryStore) {
  const acc = [];
  for await (const r of store.iterate()) acc.push(r);
  return acc;
}

describe("HistoryRecordingInterceptor", () => {
  it("records a success on /query (no :id) with conn=_default", async () => {
    const store = new InMemoryHistoryStore();
    const rec = new RecordHistory(store);
    const interceptor = new HistoryRecordingInterceptor(rec);
    const result = selectResult(2);
    const ctx = execCtx({ body: { sql: "SELECT 1" }, params: {} });
    const next: CallHandler<QueryResult> = { handle: () => of(result) };

    const out = await firstValueFrom(interceptor.intercept(ctx, next));

    expect(out).toBe(result);
    const [record] = await collect(store);
    expect(record).toMatchObject({
      status: "ok",
      conn: "_default",
      sql: "SELECT 1",
      rows: 2,
      rows_affected: null,
      actor: null,
      error: null,
    });
  });

  it("records a success on /connections/:id/query with the route's connection id", async () => {
    const store = new InMemoryHistoryStore();
    const rec = new RecordHistory(store);
    const interceptor = new HistoryRecordingInterceptor(rec);
    const ctx = execCtx({ body: { sql: "SELECT 1" }, params: { id: "prod-pg" } });
    const next: CallHandler<QueryResult> = { handle: () => of(selectResult(1)) };

    await firstValueFrom(interceptor.intercept(ctx, next));

    const [record] = await collect(store);
    expect(record.conn).toBe("prod-pg");
  });

  it("records an error and re-throws so the contract filter still owns the response", async () => {
    const store = new InMemoryHistoryStore();
    const rec = new RecordHistory(store);
    const interceptor = new HistoryRecordingInterceptor(rec);
    const err = new QueryError("bad sql");
    const ctx = execCtx({ body: { sql: "BAD" }, params: { id: "prod-pg" } });
    const next: CallHandler<QueryResult> = { handle: () => throwError(() => err) };

    await expect(firstValueFrom(interceptor.intercept(ctx, next))).rejects.toBe(err);

    const [record] = await collect(store);
    expect(record).toMatchObject({
      status: "error",
      conn: "prod-pg",
      sql: "BAD",
      error: { category: "query", message: "bad sql" },
    });
  });

  it("swallows recorder failures so a buggy mapper never fails the user-facing request", async () => {
    const rec = {
      recordSuccess: vi.fn().mockRejectedValue(new Error("recorder exploded")),
      recordError: vi.fn(),
    } as unknown as RecordHistory;
    const interceptor = new HistoryRecordingInterceptor(rec);
    const result = selectResult(1);
    const ctx = execCtx({ body: { sql: "SELECT 1" }, params: {} });
    const next: CallHandler<QueryResult> = { handle: () => of(result) };

    const out = await firstValueFrom(interceptor.intercept(ctx, next));
    expect(out).toBe(result);
  });

  it("captures duration from a single clock so ts and duration share a base", async () => {
    const store = new InMemoryHistoryStore();
    let clock = 1_780_000_000_000;
    const rec = new RecordHistory(store, () => clock);
    const interceptor = new HistoryRecordingInterceptor(rec, () => clock);
    const ctx = execCtx({ body: { sql: "SELECT 1" }, params: {} });
    const next: CallHandler<QueryResult> = {
      handle: () => {
        clock += 25;
        return of(selectResult(1));
      },
    };

    await firstValueFrom(interceptor.intercept(ctx, next));

    const [record] = await collect(store);
    expect(record.duration_ms).toBe(25);
    expect(record.ts).toBe(new Date(1_780_000_000_025).toISOString());
  });
});
