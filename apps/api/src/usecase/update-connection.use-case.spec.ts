import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import { NULL_CAPABILITIES } from "../domain/values";
import type { AdapterFactory } from "./adapter-factory.port";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { UpdateConnection } from "./update-connection.use-case";

function stubAdapter(id = "postgres", close?: () => Promise<void>): DatabaseAdapter {
  return {
    getId: () => id,
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
    ...(close && { close }),
  };
}

// Upserts by id like `InMemoryConnectionRegistry` does, because that is the
// behaviour this use case leans on: an edited connection keeps its place in
// the list rather than jumping to the end of the sidebar.
function inMemoryRegistry(seed: ConnectionRecord[] = []): {
  registry: ConnectionRegistry;
  records: Map<string, ConnectionRecord>;
} {
  const records = new Map(seed.map((r) => [r.id, r]));
  return {
    records,
    registry: {
      add: (r) => {
        records.set(r.id, r);
      },
      list: () => [...records.values()],
      get: (id) => records.get(id),
      delete: (id) => records.delete(id),
    },
  };
}

describe("UpdateConnection", () => {
  let factory: AdapterFactory;
  let rebuilt: DatabaseAdapter;

  beforeEach(() => {
    rebuilt = stubAdapter();
    factory = {
      create: async () => stubAdapter(),
      rebuild: vi.fn().mockImplementation(async () => rebuilt),
      supported: () => ["postgres", "null"],
    };
  });

  function seeded(overrides: Partial<ConnectionRecord> = {}): {
    registry: ConnectionRegistry;
    records: Map<string, ConnectionRecord>;
    adapter: DatabaseAdapter;
  } {
    const adapter =
      overrides.adapter ?? stubAdapter("postgres", vi.fn().mockResolvedValue(undefined));
    const { registry, records } = inMemoryRegistry([
      {
        id: "c1",
        label: "Prod",
        driver: "postgres",
        adapter,
        parts: { host: "old.host", port: 5432, database: "app", user: "reader" },
        ...overrides,
      },
    ]);
    return { registry, records, adapter };
  }

  it("raises CapabilityError for an id nobody registered", async () => {
    // Same shape as ExecuteQuery's unknown-connection path, so a stale tab
    // editing a deleted connection gets a 404 and not a 500.
    const { registry } = seeded();
    await expect(
      new UpdateConnection(registry, factory).execute("nope", { label: "x" }),
    ).rejects.toThrowError(CapabilityError);
  });

  it("renames without disturbing the pool", async () => {
    // A label is not a connection detail. Rebuilding for one would drop
    // every open socket and re-authenticate, which is a strange thing for
    // typing in a name box to do.
    const { registry, records, adapter } = seeded();

    const view = await new UpdateConnection(registry, factory).execute("c1", { label: "Staging" });

    expect(view).toEqual({
      id: "c1",
      label: "Staging",
      driver: "postgres",
      parts: { host: "old.host", port: 5432, database: "app", user: "reader" },
    });
    expect(factory.rebuild).not.toHaveBeenCalled();
    expect(adapter.close).not.toHaveBeenCalled();
    expect(records.get("c1")?.adapter).toBe(adapter);
  });

  it("rebuilds through the old adapter when the connection details change", async () => {
    // The old adapter is the argument, not just the thing being replaced:
    // it is the only holder of the password, so a rebuild that did not
    // start from it could not keep one (ADR-0080).
    const { registry, records, adapter } = seeded();

    await new UpdateConnection(registry, factory).execute("c1", {
      host: "new.host",
      port: 5432,
      database: "app",
      user: "reader",
      password: "",
    });

    expect(factory.rebuild).toHaveBeenCalledWith(adapter, "postgres", {
      host: "new.host",
      port: 5432,
      database: "app",
      user: "reader",
      password: "",
    });
    expect(records.get("c1")?.adapter).toBe(rebuilt);
  });

  it("treats putting a connection behind a bastion as an edit, not a rename", async () => {
    // 0031 slice D. An `ssh` block changes where the connection reaches the
    // database from, so a body carrying one has to rebuild — read as a
    // rename it would be stored as a no-op and the connection would keep
    // going direct, which is precisely the case the operator was trying to
    // stop.
    const { registry, records, adapter } = seeded();
    const ssh = { host: "bastion", user: "jump", password: "pw", fingerprint: "SHA256:x" };

    await new UpdateConnection(registry, factory).execute("c1", { ssh });

    expect(factory.rebuild).toHaveBeenCalledWith(adapter, "postgres", { ssh });
    expect(records.get("c1")?.adapter).toBe(rebuilt);
  });

  it("keeps the driver the connection was registered with", async () => {
    // Not editable, and deliberately: swapping the driver under a live id
    // would keep the label while changing what the connection *is*. Delete
    // and add is the honest way to do that, and it is rare enough to cost
    // nothing.
    const { registry } = seeded({ driver: "null" });

    const view = await new UpdateConnection(registry, factory).execute("c1", { host: "new.host" });

    expect(factory.rebuild).toHaveBeenCalledWith(expect.anything(), "null", { host: "new.host" });
    expect(view.driver).toBe("null");
  });

  it("closes the pool it replaced", async () => {
    const { registry, adapter } = seeded();

    await new UpdateConnection(registry, factory).execute("c1", { host: "new.host" });

    expect(adapter.close).toHaveBeenCalledOnce();
  });

  it("leaves the connection working when the new configuration is refused", async () => {
    // Build first, tear down second. The factory validates, so an edit that
    // names no host must not cost the user the connection they were editing.
    const { registry, records, adapter } = seeded();
    factory.rebuild = vi.fn().mockImplementation(() => {
      throw new CapabilityError("postgres driver requires either connectionString or host");
    });

    await expect(
      new UpdateConnection(registry, factory).execute("c1", { user: "reader" }),
    ).rejects.toThrowError(CapabilityError);

    expect(records.get("c1")?.adapter).toBe(adapter);
    expect(adapter.close).not.toHaveBeenCalled();
    expect(records.get("c1")?.label).toBe("Prod");
  });

  it("completes the edit even when the old pool refuses to shut down", async () => {
    // Same reasoning as DeleteConnection: the caller asked for the
    // connection to point somewhere else, and a half-shut socket is not
    // their problem. The new adapter is already live by this point.
    const { registry, records } = seeded({
      adapter: stubAdapter("postgres", vi.fn().mockRejectedValue(new Error("already ended"))),
    });

    await expect(
      new UpdateConnection(registry, factory).execute("c1", { host: "new.host" }),
    ).resolves.toMatchObject({ id: "c1" });
    expect(records.get("c1")?.adapter).toBe(rebuilt);
  });

  it("re-describes where the connection points, and still describes no password", async () => {
    const { registry, records } = seeded();

    const view = await new UpdateConnection(registry, factory).execute("c1", {
      host: "new.host",
      port: 6543,
      user: "writer",
      password: "SECRET-PW",
      sslMode: "disable",
    });

    expect(view.parts).toEqual({
      host: "new.host",
      port: 6543,
      user: "writer",
      sslMode: "disable",
    });
    // The cleared database box is cleared in the parts too — the form
    // submits every box it rendered, so an absent field is a removal.
    expect(view.parts).not.toHaveProperty("database");
    expect(JSON.stringify(records.get("c1"))).not.toContain("SECRET");
    expect(records.get("c1")).not.toHaveProperty("parts.password");
  });

  it("keeps a renamed connection in its place in the list", async () => {
    // `list()` order is sidebar order. An edit that moved a connection to
    // the bottom would be a small betrayal of a user who just renamed it.
    const { registry } = inMemoryRegistry([
      { id: "a", label: "A", driver: "null", adapter: stubAdapter("null") },
      { id: "b", label: "B", driver: "null", adapter: stubAdapter("null") },
      { id: "c", label: "C", driver: "null", adapter: stubAdapter("null") },
    ]);

    await new UpdateConnection(registry, factory).execute("b", { label: "B renamed" });

    expect(registry.list().map((r) => r.label)).toEqual(["A", "B renamed", "C"]);
  });

  it("accepts an edit that says nothing and changes nothing", async () => {
    // PATCH is idempotent, and an empty body is the identity edit. Erroring
    // would make the form responsible for detecting that nothing moved.
    const { registry, adapter } = seeded();

    const view = await new UpdateConnection(registry, factory).execute("c1", {});

    expect(view).toMatchObject({ label: "Prod" });
    expect(factory.rebuild).not.toHaveBeenCalled();
    expect(adapter.close).not.toHaveBeenCalled();
  });
});
