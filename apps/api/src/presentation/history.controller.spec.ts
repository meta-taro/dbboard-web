import { describe, expect, it, vi } from "vitest";
import type { Response } from "express";
import type { HistoryRecord } from "../domain/history-record";
import { InMemoryHistoryStore } from "../infrastructure/in-memory-history-store";
import { ExportHistory } from "../usecase/export-history.use-case";
import { HistoryController } from "./history.controller";

// The export route streams whatever the store holds, kind included, so a
// query record is a sufficient stand-in for the streaming assertions.
type QueryRecord = Extract<HistoryRecord, { kind: "query" }>;

function record(overrides: Partial<QueryRecord> = {}): QueryRecord {
  return {
    v: 2,
    kind: "query",
    ts: "2026-06-04T14:22:01.123Z",
    conn: "prod-pg",
    actor: null,
    sql: "SELECT 1",
    status: "ok",
    duration_ms: 1,
    rows: 1,
    rows_affected: null,
    error: null,
    ...overrides,
  };
}

function mockResponse(): {
  res: Response;
  setHeader: ReturnType<typeof vi.fn>;
  write: ReturnType<typeof vi.fn>;
  end: ReturnType<typeof vi.fn>;
} {
  const setHeader = vi.fn();
  const write = vi.fn();
  const end = vi.fn();
  const res = { setHeader, write, end } as unknown as Response;
  return { res, setHeader, write, end };
}

describe("HistoryController", () => {
  it("serves application/x-ndjson", async () => {
    const store = new InMemoryHistoryStore();
    const controller = new HistoryController(new ExportHistory(store));
    const { res, setHeader, end } = mockResponse();

    await controller.export(res);

    expect(setHeader).toHaveBeenCalledWith("Content-Type", "application/x-ndjson");
    expect(end).toHaveBeenCalledTimes(1);
  });

  it("writes one NDJSON line per record (round-trips byte-identically)", async () => {
    const store = new InMemoryHistoryStore();
    const records: HistoryRecord[] = [
      record({ ts: "2026-06-04T14:22:01.001Z" }),
      record({
        ts: "2026-06-04T14:22:01.002Z",
        status: "error",
        rows: null,
        rows_affected: null,
        error: { category: "query", message: "boom" },
      }),
    ];
    for (const r of records) await store.record(r);
    const controller = new HistoryController(new ExportHistory(store));
    const { res, write } = mockResponse();

    await controller.export(res);

    expect(write).toHaveBeenCalledTimes(2);
    const parsed = write.mock.calls.map(([chunk]) => JSON.parse((chunk as string).trimEnd()));
    expect(parsed).toEqual(records);
  });

  it("ends the response cleanly when the store is empty", async () => {
    const store = new InMemoryHistoryStore();
    const controller = new HistoryController(new ExportHistory(store));
    const { res, write, end } = mockResponse();

    await controller.export(res);

    expect(write).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
  });
});
