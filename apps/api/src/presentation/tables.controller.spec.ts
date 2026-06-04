import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import { ListTables } from "../usecase/list-tables.use-case";
import { TablesController } from "./tables.controller";

function adapter(): DatabaseAdapter {
  return {
    getId: () => "null",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [
      { schema: null, name: "users" },
      { schema: "auth", name: "sessions" },
    ],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

describe("TablesController", () => {
  it("delegates to ListTables and returns the contract shape", async () => {
    const controller = new TablesController(new ListTables(adapter()));
    await expect(controller.list()).resolves.toEqual({
      tables: [
        { schema: null, name: "users" },
        { schema: "auth", name: "sessions" },
      ],
    });
  });
});
