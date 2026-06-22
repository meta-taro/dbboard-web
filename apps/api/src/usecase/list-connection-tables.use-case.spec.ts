import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import { NULL_CAPABILITIES, type TableInfo } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { ListConnectionTables } from "./list-connection-tables.use-case";

function adapter(name: string, tables: TableInfo[]): DatabaseAdapter {
  return {
    getId: () => name,
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: vi.fn().mockResolvedValue(tables),
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
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

describe("ListConnectionTables", () => {
  const defaultTables: TableInfo[] = [{ schema: null, name: "default_users" }];
  const scopedTables: TableInfo[] = [
    { schema: "public", name: "accounts" },
    { schema: "auth", name: "sessions" },
  ];

  it("dispatches to the default adapter when no connectionId is supplied", async () => {
    const defaultAdapter = adapter("default", defaultTables);
    const useCase = new ListConnectionTables(defaultAdapter, registry([]));
    await expect(useCase.execute()).resolves.toEqual({ tables: defaultTables });
    expect(defaultAdapter.listTables).toHaveBeenCalledOnce();
  });

  it("dispatches to the registry-resolved adapter when a connectionId is supplied", async () => {
    const defaultAdapter = adapter("default", defaultTables);
    const scoped = adapter("conn-a", scopedTables);
    const useCase = new ListConnectionTables(
      defaultAdapter,
      registry([{ id: "conn-a", label: "A", driver: "null", adapter: scoped }]),
    );
    await expect(useCase.execute("conn-a")).resolves.toEqual({ tables: scopedTables });
    expect(scoped.listTables).toHaveBeenCalledOnce();
    expect(defaultAdapter.listTables).not.toHaveBeenCalled();
  });

  it("raises CapabilityError for an unknown connectionId so the route 404s", async () => {
    const useCase = new ListConnectionTables(adapter("default", defaultTables), registry([]));
    await expect(useCase.execute("missing")).rejects.toBeInstanceOf(CapabilityError);
    await expect(useCase.execute("missing")).rejects.toThrow(/unknown connection/);
  });
});
