import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import { NULL_CAPABILITIES, type QueryResult } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { ExecuteQuery } from "./execute-query.use-case";

function adapter(name: string, result: QueryResult): DatabaseAdapter {
  return {
    getId: () => name,
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: vi.fn().mockResolvedValue(result),
  };
}

function registry(records: ConnectionRecord[]): ConnectionRegistry {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    add: () => undefined,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    delete: () => true,
  };
}

describe("ExecuteQuery", () => {
  const result: QueryResult = {
    columns: [{ name: "one", declared_type: null }],
    rows: [[1]],
    rows_affected: 0,
  };
  let defaultAdapter: DatabaseAdapter;

  beforeEach(() => {
    defaultAdapter = adapter("default", result);
  });

  it("dispatches to the default adapter when no connectionId is supplied", async () => {
    const useCase = new ExecuteQuery(defaultAdapter, registry([]));
    await expect(useCase.execute("SELECT 1")).resolves.toBe(result);
    expect(defaultAdapter.executeQuery).toHaveBeenCalledWith("SELECT 1");
  });

  it("dispatches to the registry-resolved adapter when a connectionId is supplied", async () => {
    const namedAdapter = adapter("conn-a", result);
    const useCase = new ExecuteQuery(
      defaultAdapter,
      registry([{ id: "conn-a", label: "A", driver: "null", adapter: namedAdapter }]),
    );
    await expect(useCase.execute("SELECT 2", "conn-a")).resolves.toBe(result);
    expect(namedAdapter.executeQuery).toHaveBeenCalledWith("SELECT 2");
    expect(defaultAdapter.executeQuery).not.toHaveBeenCalled();
  });

  it("raises CapabilityError for an unknown connectionId so the route 404s", async () => {
    const useCase = new ExecuteQuery(defaultAdapter, registry([]));
    await expect(useCase.execute("SELECT 1", "missing")).rejects.toBeInstanceOf(CapabilityError);
  });
});
