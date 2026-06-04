import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { ConnectionRecord } from "../usecase/connection-registry.port";
import { InMemoryConnectionRegistry } from "./in-memory-connection-registry";

function fakeAdapter(id = "null"): DatabaseAdapter {
  return {
    getId: () => id,
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

function fakeRecord(id: string): ConnectionRecord {
  return { id, label: `label-${id}`, driver: "null", adapter: fakeAdapter() };
}

describe("InMemoryConnectionRegistry", () => {
  let registry: InMemoryConnectionRegistry;

  beforeEach(() => {
    registry = new InMemoryConnectionRegistry();
  });

  it("starts empty", () => {
    expect(registry.list()).toEqual([]);
  });

  it("adds and retrieves by id", () => {
    const record = fakeRecord("aaa");
    registry.add(record);
    expect(registry.get("aaa")).toBe(record);
    expect(registry.list()).toEqual([record]);
  });

  it("returns undefined for an unknown id (controller turns this into 404)", () => {
    expect(registry.get("missing")).toBeUndefined();
  });

  it("delete returns true on success and false when the id was unknown", () => {
    registry.add(fakeRecord("a"));
    expect(registry.delete("a")).toBe(true);
    expect(registry.get("a")).toBeUndefined();
    expect(registry.delete("a")).toBe(false);
  });

  it("preserves insertion order in list() so the UI list is stable", () => {
    const a = fakeRecord("a");
    const b = fakeRecord("b");
    const c = fakeRecord("c");
    registry.add(a);
    registry.add(b);
    registry.add(c);
    expect(registry.list().map((r) => r.id)).toEqual(["a", "b", "c"]);
  });
});
