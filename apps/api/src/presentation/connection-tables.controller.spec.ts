import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "../usecase/connection-registry.port";
import { ListConnectionTables } from "../usecase/list-connection-tables.use-case";
import { ConnectionTablesController } from "./connection-tables.controller";

function adapter(): DatabaseAdapter {
  return {
    getId: () => "scoped",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: vi.fn().mockResolvedValue([
      { schema: "public", name: "users" },
      { schema: null, name: "kv" },
    ]),
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

describe("ConnectionTablesController", () => {
  it("delegates to ListConnectionTables and returns the contract shape", async () => {
    const scoped = adapter();
    const useCase = new ListConnectionTables(
      adapter(),
      registry([{ id: "abc", label: "A", driver: "null", adapter: scoped }]),
    );
    const controller = new ConnectionTablesController(useCase);
    await expect(controller.listOn("abc")).resolves.toEqual({
      tables: [
        { schema: "public", name: "users" },
        { schema: null, name: "kv" },
      ],
    });
    expect(scoped.listTables).toHaveBeenCalledOnce();
  });
});
