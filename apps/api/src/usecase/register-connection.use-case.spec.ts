import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import { type SshParts, resolveSshTunnelConfig, sshPartsOf } from "../domain/ssh";
import { NULL_CAPABILITIES } from "../domain/values";
import type { AdapterFactory } from "./adapter-factory.port";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { RegisterConnection } from "./register-connection.use-case";

// The tunnel resolver insists a private key is key material and not a path,
// so the fixture has to look like one (`scripts/pii-scan.allow` allows this
// exact shape).
const KEY_MATERIAL = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

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

// Models the shape of the real factory rather than the shape of the request:
// the block is resolved while the adapter is built, and `describeTunnel`
// answers from the adapter afterwards. A fake that projected the request
// instead would be unable to model a credential carried over from a previous
// adapter, which is the case slice F2 exists for.
function tunnelAwareFactory(): AdapterFactory {
  const tunnels = new WeakMap<DatabaseAdapter, SshParts>();
  return {
    create: async (_driver, config) => {
      const adapter = stubAdapter();
      if (config.ssh) tunnels.set(adapter, sshPartsOf(resolveSshTunnelConfig(config.ssh)));
      return adapter;
    },
    rebuild: async (previous) => previous,
    describeTunnel: (adapter) => tunnels.get(adapter),
    supported: () => ["postgres"],
  };
}

describe("RegisterConnection", () => {
  let factory: AdapterFactory;

  beforeEach(() => {
    factory = {
      create: async (driver) => (driver === "null" ? stubAdapter() : throwUnknown(driver)),
      // Registration never rebuilds; the member exists because the port
      // declares it (0027 slice G).
      rebuild: async (previous) => previous,
      supported: () => ["null"],
    };
  });

  it("constructs an adapter, generates an id, and stores the record", async () => {
    const { registry, records } = inMemoryRegistry();
    const useCase = new RegisterConnection(registry, factory, () => "fixed-id");

    const out = await useCase.execute({ label: "local", driver: "null" });

    expect(out).toEqual({ id: "fixed-id" });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: "fixed-id", label: "local", driver: "null" });
    expect(records[0]?.adapter.getId()).toBe("null");
  });

  it("forwards the whole config to the factory but keeps only its non-secret half", async () => {
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
      {
        create: factorySpy,
        rebuild: async (previous) => previous,
        supported: () => ["null", "postgres"],
      },
      () => "fixed-id",
    );

    await useCase.execute({
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

  it("stores the split fields as parts, minus the password", async () => {
    const { registry, records } = inMemoryRegistry();
    const useCase = new RegisterConnection(
      registry,
      {
        create: async () => stubAdapter(),
        rebuild: async (previous) => previous,
        supported: () => ["postgres"],
      },
      () => "fixed-id",
    );

    await useCase.execute({
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

  it("stores the tunnel's non-secret half alongside the database's", async () => {
    // 0031 slice F. Without this the edit form cannot show that a connection
    // runs through a bastion at all, and an operator editing the port would
    // have no way to tell where the traffic actually goes.
    const { registry, records } = inMemoryRegistry();
    await new RegisterConnection(registry, tunnelAwareFactory(), () => "fixed-id").execute({
      label: "Prod",
      driver: "postgres",
      host: "db.internal",
      database: "app",
      user: "reader",
      password: "SECRET-PW",
      ssh: {
        host: "bastion.example.com",
        port: 2222,
        user: "deploy",
        privateKey: KEY_MATERIAL,
        passphrase: "SECRET-PHRASE",
        fingerprint: "SHA256:abc",
      },
    });

    expect(records[0]?.ssh).toEqual({
      host: "bastion.example.com",
      port: 2222,
      user: "deploy",
      auth: "private-key",
      hostKey: { kind: "fingerprint", fingerprint: "SHA256:abc" },
    });
    // The leak test the database half already has, extended to the bastion:
    // the record describes the tunnel and holds none of its credentials.
    expect(JSON.stringify({ ...records[0], adapter: undefined })).not.toContain("SECRET");
    expect(JSON.stringify({ ...records[0], adapter: undefined })).not.toContain("OPENSSH");
  });

  it("stores no ssh description for a direct connection", async () => {
    const { registry, records } = inMemoryRegistry();
    await new RegisterConnection(registry, tunnelAwareFactory(), () => "fixed-id").execute({
      label: "Prod",
      driver: "postgres",
      host: "db.internal",
    });

    expect(records[0]).not.toHaveProperty("ssh");
  });

  it("stores no parts for a connection that has none", async () => {
    // The `null` driver names no host. An empty parts object would claim
    // there is a connection to describe.
    const { registry, records } = inMemoryRegistry();
    await new RegisterConnection(registry, factory, () => "fixed-id").execute({
      label: "local",
      driver: "null",
    });

    expect(records[0]).not.toHaveProperty("parts");
  });

  it("propagates the factory's CapabilityError for unknown drivers", async () => {
    const { registry, records } = inMemoryRegistry();
    const useCase = new RegisterConnection(registry, factory);
    await expect(useCase.execute({ label: "x", driver: "mongo" })).rejects.toThrowError(
      CapabilityError,
    );
    expect(records).toHaveLength(0);
  });
});

function throwUnknown(driver: string): never {
  throw new CapabilityError(`unknown driver: ${driver}`);
}
