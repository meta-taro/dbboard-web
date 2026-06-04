import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import { NULL_CAPABILITIES } from "../domain/values";
import type { AdapterFactory } from "./adapter-factory.port";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { RegisterConnection } from "./register-connection.use-case";

function stubAdapter(): DatabaseAdapter {
  return {
    getId: () => "null",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

function inMemoryRegistry(): { registry: ConnectionRegistry; records: ConnectionRecord[] } {
  const records: ConnectionRecord[] = [];
  return {
    records,
    registry: {
      add: (r) => {
        records.push(r);
      },
      list: () => records,
      get: (id) => records.find((r) => r.id === id),
      delete: (id) => {
        const i = records.findIndex((r) => r.id === id);
        if (i < 0) return false;
        records.splice(i, 1);
        return true;
      },
    },
  };
}

describe("RegisterConnection", () => {
  let factory: AdapterFactory;

  beforeEach(() => {
    factory = {
      create: (driver) => (driver === "null" ? stubAdapter() : throwUnknown(driver)),
    };
  });

  it("constructs an adapter, generates an id, and stores the record", () => {
    const { registry, records } = inMemoryRegistry();
    const useCase = new RegisterConnection(registry, factory, () => "fixed-id");

    const out = useCase.execute({ label: "local", driver: "null" });

    expect(out).toEqual({ id: "fixed-id" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "fixed-id", label: "local", driver: "null" });
    expect(records[0]?.adapter.getId()).toBe("null");
  });

  it("forwards the connection config to the factory but does NOT copy it onto the record", () => {
    // The leak path 0004 § Tasks calls out: passwords / connection strings
    // travel through the use case to the factory, but they must never land
    // on the ConnectionRecord — only the adapter holds them.
    const { registry, records } = inMemoryRegistry();
    const factorySpy = vi.fn().mockReturnValue(stubAdapter());
    const useCase = new RegisterConnection(registry, { create: factorySpy }, () => "fixed-id");

    useCase.execute({
      label: "Prod",
      driver: "postgres",
      connectionString: "postgresql://u:SECRET@host/db",
      password: "SECRET-PW",
    });

    expect(factorySpy).toHaveBeenCalledWith("postgres", {
      connectionString: "postgresql://u:SECRET@host/db",
      password: "SECRET-PW",
    });
    expect(records[0]).toEqual({
      id: "fixed-id",
      label: "Prod",
      driver: "postgres",
      adapter: expect.any(Object),
    });
    // Belt and braces: nothing on the record encodes the password.
    expect(JSON.stringify({ ...records[0], adapter: undefined })).not.toContain("SECRET");
  });

  it("propagates the factory's CapabilityError for unknown drivers", () => {
    const { registry, records } = inMemoryRegistry();
    const useCase = new RegisterConnection(registry, factory);
    expect(() => useCase.execute({ label: "x", driver: "mongo" })).toThrowError(CapabilityError);
    expect(records).toHaveLength(0);
  });
});

function throwUnknown(driver: string): never {
  throw new CapabilityError(`unknown driver: ${driver}`);
}
