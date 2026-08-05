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
      supported: () => ["null"],
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

  it("forwards the whole config to the factory but keeps only its non-secret half", () => {
    // The leak path 0004 § Tasks calls out: passwords / connection strings
    // travel through the use case to the factory, but they must never land
    // on the ConnectionRecord — only the adapter holds them.
    //
    // Rewritten in 0027 slice F, not deleted (baseline §7). The rule it pins
    // is unchanged and the password assertion below is the same one; what
    // changed is that the record no longer keeps *nothing*. Remembering none
    // of the connection was what blocked the edit form (ADR-0080), so the
    // non-secret parts are now kept and the credential still is not.
    const { registry, records } = inMemoryRegistry();
    const factorySpy = vi.fn().mockReturnValue(stubAdapter());
    const useCase = new RegisterConnection(
      registry,
      { create: factorySpy, supported: () => ["null", "postgres"] },
      () => "fixed-id",
    );

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
      parts: { host: "host", database: "db", user: "u" },
    });
    // Belt and braces, and now load-bearing for the URL branch specifically:
    // the DSN handed to the factory contains the password, so the parts had
    // to be extracted from it and the credential dropped on the way past.
    expect(JSON.stringify({ ...records[0], adapter: undefined })).not.toContain("SECRET");
    expect(records[0]?.parts).not.toHaveProperty("password");
    expect(records[0]).not.toHaveProperty("connectionString");
  });

  it("stores the split fields as parts, minus the password", () => {
    const { registry, records } = inMemoryRegistry();
    const useCase = new RegisterConnection(
      registry,
      { create: () => stubAdapter(), supported: () => ["postgres"] },
      () => "fixed-id",
    );

    useCase.execute({
      label: "Prod",
      driver: "postgres",
      host: "db.internal",
      port: 5432,
      database: "app",
      user: "reader",
      password: "SECRET-PW",
      sslMode: "require",
    });

    expect(records[0]?.parts).toEqual({
      host: "db.internal",
      port: 5432,
      database: "app",
      user: "reader",
      sslMode: "require",
    });
    expect(JSON.stringify({ ...records[0], adapter: undefined })).not.toContain("SECRET");
  });

  it("stores no parts for a connection that has none", () => {
    // The `null` driver names no host. An empty parts object would claim
    // there is a connection to describe.
    const { registry, records } = inMemoryRegistry();
    new RegisterConnection(registry, factory, () => "fixed-id").execute({
      label: "local",
      driver: "null",
    });

    expect(records[0]).not.toHaveProperty("parts");
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
