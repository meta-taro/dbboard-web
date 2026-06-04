import { describe, expect, it } from "vitest";
import { CapabilityError } from "../domain/errors";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "../usecase/connection-registry.port";
import { ExecuteQuery } from "../usecase/execute-query.use-case";
import { QueryController } from "./query.controller";

function adapter(label: string): DatabaseAdapter {
  return {
    getId: () => label,
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async (sql) => ({
      columns: [{ name: "echo", declared_type: "text" }],
      rows: [[`${label}:${sql}`]],
      rows_affected: 0,
    }),
  };
}

function registry(records: ConnectionRecord[]): ConnectionRegistry {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    add: () => undefined,
    list: () => Array.from(map.values()),
    get: (id) => map.get(id),
    delete: () => true,
  };
}

describe("QueryController", () => {
  it("POST /query routes through the default adapter", async () => {
    const controller = new QueryController(new ExecuteQuery(adapter("default"), registry([])));
    const result = await controller.run({ sql: "SELECT 1" });
    expect(result.rows[0]).toEqual(["default:SELECT 1"]);
  });

  it("POST /connections/:id/query routes through the matching registry entry", async () => {
    const records: ConnectionRecord[] = [
      { id: "abc", label: "Specific", driver: "null", adapter: adapter("abc") },
    ];
    const controller = new QueryController(new ExecuteQuery(adapter("default"), registry(records)));
    const result = await controller.runOn("abc", { sql: "SELECT 1" });
    expect(result.rows[0]).toEqual(["abc:SELECT 1"]);
  });

  it("POST /connections/:id/query raises CapabilityError for an unknown id (→ 404 via the filter)", async () => {
    const controller = new QueryController(new ExecuteQuery(adapter("default"), registry([])));
    await expect(controller.runOn("ghost", { sql: "SELECT 1" })).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });
});
