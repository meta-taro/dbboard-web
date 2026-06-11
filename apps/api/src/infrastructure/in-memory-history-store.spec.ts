import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "../domain/history-record";
import { InMemoryHistoryStore } from "./in-memory-history-store";

function makeRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
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

async function collect(iter: AsyncIterable<HistoryRecord>): Promise<HistoryRecord[]> {
  const acc: HistoryRecord[] = [];
  for await (const r of iter) acc.push(r);
  return acc;
}

describe("InMemoryHistoryStore", () => {
  it("starts empty", async () => {
    const store = new InMemoryHistoryStore();
    expect(await collect(store.iterate())).toEqual([]);
  });

  it("records and replays in insertion order", async () => {
    const store = new InMemoryHistoryStore();
    const a = makeRecord({ ts: "2026-06-04T14:22:01.001Z" });
    const b = makeRecord({ ts: "2026-06-04T14:22:01.002Z" });
    const c = makeRecord({ ts: "2026-06-04T14:22:01.003Z" });
    await store.record(a);
    await store.record(b);
    await store.record(c);
    expect(await collect(store.iterate())).toEqual([a, b, c]);
  });

  it("iterate() returns a fresh snapshot per call (writes after start do not leak in)", async () => {
    const store = new InMemoryHistoryStore();
    const first = makeRecord({ sql: "SELECT 1" });
    await store.record(first);

    const iterator = store.iterate()[Symbol.asyncIterator]();
    const step = await iterator.next();
    expect(step.done).toBe(false);
    expect(step.value).toEqual(first);

    await store.record(makeRecord({ sql: "SELECT 2" }));
    expect((await iterator.next()).done).toBe(true);
  });
});
