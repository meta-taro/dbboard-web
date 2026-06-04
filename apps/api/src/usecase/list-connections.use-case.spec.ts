import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { ListConnections } from "./list-connections.use-case";

function adapter(): DatabaseAdapter {
  return {
    getId: () => "null",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

function registry(records: ConnectionRecord[]): ConnectionRegistry {
  return {
    add: () => undefined,
    list: () => records,
    get: () => undefined,
    delete: () => true,
  };
}

describe("ListConnections", () => {
  it("returns id / label / driver only — strips the adapter instance", () => {
    const records: ConnectionRecord[] = [
      { id: "a", label: "Local", driver: "null", adapter: adapter() },
      { id: "b", label: "Prod", driver: "null", adapter: adapter() },
    ];
    const out = new ListConnections(registry(records)).execute();
    expect(out).toEqual({
      connections: [
        { id: "a", label: "Local", driver: "null" },
        { id: "b", label: "Prod", driver: "null" },
      ],
    });
    // Belt and braces: the projected object must not expose `adapter`,
    // since 0004 will start carrying secrets on the record.
    for (const view of out.connections) {
      expect(view).not.toHaveProperty("adapter");
    }
  });

  it("returns an empty list when nothing is registered", () => {
    expect(new ListConnections(registry([])).execute()).toEqual({ connections: [] });
  });
});
