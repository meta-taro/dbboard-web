import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import { NULL_CAPABILITIES, type Capabilities } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { GetConnectionCapabilities } from "./get-connection-capabilities.use-case";

function adapter(name: string, capabilities: Capabilities): DatabaseAdapter {
  return {
    getId: () => name,
    getCapabilities: () => capabilities,
    listTables: async () => [],
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

const describing: Capabilities = { ...NULL_CAPABILITIES, has_describe_table: true };

describe("GetConnectionCapabilities", () => {
  // The reason this route exists: GET /capabilities answers for the
  // bootstrap adapter, which is NullAdapter and always will be. A client
  // reading it would conclude that no connection can describe a table.
  it("answers for the connection's own adapter, not the bootstrap one", () => {
    const useCase = new GetConnectionCapabilities(
      adapter("null", NULL_CAPABILITIES),
      registry([
        { id: "c1", label: "pg", driver: "postgres", adapter: adapter("postgres", describing) },
      ]),
    );

    expect(useCase.execute("c1")).toEqual({ id: "postgres", capabilities: describing });
  });

  it("falls back to the default adapter when no connectionId is supplied", () => {
    const useCase = new GetConnectionCapabilities(adapter("null", NULL_CAPABILITIES), registry([]));
    expect(useCase.execute(undefined)).toEqual({ id: "null", capabilities: NULL_CAPABILITIES });
  });

  it("raises CapabilityError for an unknown connectionId", () => {
    const useCase = new GetConnectionCapabilities(adapter("null", NULL_CAPABILITIES), registry([]));
    expect(() => useCase.execute("missing")).toThrow(CapabilityError);
  });
});
