import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "../domain/history-record";
import { InMemoryHistoryStore } from "../infrastructure/in-memory-history-store";
import { ExportHistory } from "./export-history.use-case";

function record(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
  return {
    v: 1,
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

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const acc: string[] = [];
  for await (const chunk of iter) acc.push(chunk);
  return acc;
}

describe("ExportHistory", () => {
  it("yields zero lines when the store is empty", async () => {
    const store = new InMemoryHistoryStore();
    const exp = new ExportHistory(store);
    expect(await collect(exp.stream())).toEqual([]);
  });

  it("emits one NDJSON line per record, terminated by \\n", async () => {
    const store = new InMemoryHistoryStore();
    await store.record(record({ ts: "2026-06-04T14:22:01.001Z" }));
    await store.record(record({ ts: "2026-06-04T14:22:01.002Z", sql: "SELECT 2" }));
    const exp = new ExportHistory(store);

    const lines = await collect(exp.stream());

    expect(lines).toHaveLength(2);
    for (const line of lines) expect(line.endsWith("\n")).toBe(true);
  });

  it("round-trips each record byte-identically via JSON.parse on a per-line basis", async () => {
    const store = new InMemoryHistoryStore();
    const records: HistoryRecord[] = [
      record({ ts: "2026-06-04T14:22:01.001Z", status: "ok" }),
      record({
        ts: "2026-06-04T14:22:01.002Z",
        status: "error",
        rows: null,
        rows_affected: null,
        error: { category: "query", message: "boom" },
      }),
      record({
        ts: "2026-06-04T14:22:01.003Z",
        sql: "UPDATE t SET x = 1",
        rows: null,
        rows_affected: 5,
      }),
    ];
    for (const r of records) await store.record(r);
    const exp = new ExportHistory(store);

    const lines = await collect(exp.stream());
    const parsed = lines.map((l) => JSON.parse(l.trimEnd()));

    expect(parsed).toEqual(records);
  });

  it("does not concatenate multiple records into a single chunk (one record = one yield)", async () => {
    const store = new InMemoryHistoryStore();
    await store.record(record({ ts: "2026-06-04T14:22:01.001Z" }));
    await store.record(record({ ts: "2026-06-04T14:22:01.002Z" }));
    await store.record(record({ ts: "2026-06-04T14:22:01.003Z" }));
    const exp = new ExportHistory(store);

    const chunks = await collect(exp.stream());

    for (const chunk of chunks) {
      const newlineCount = (chunk.match(/\n/g) ?? []).length;
      expect(newlineCount).toBe(1);
    }
  });
});
