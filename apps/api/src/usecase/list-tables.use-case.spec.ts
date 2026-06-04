import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES, type TableInfo } from "../domain/values";
import { ListTables } from "./list-tables.use-case";

function adapterReturning(tables: TableInfo[]): DatabaseAdapter {
  return {
    getId: () => "stub",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => tables,
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

describe("ListTables", () => {
  it("wraps the adapter's table list in the contract envelope", async () => {
    const tables: TableInfo[] = [
      { schema: null, name: "users" },
      { schema: "public", name: "accounts" },
    ];
    await expect(new ListTables(adapterReturning(tables)).execute()).resolves.toEqual({ tables });
  });

  it("returns an empty list when the adapter has none", async () => {
    await expect(new ListTables(adapterReturning([])).execute()).resolves.toEqual({ tables: [] });
  });
});
