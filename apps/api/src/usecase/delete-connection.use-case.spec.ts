import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { DeleteConnection } from "./delete-connection.use-case";

function adapterWithClose(
  closeImpl: () => Promise<void> = async () => undefined,
): DatabaseAdapter & {
  close: ReturnType<typeof vi.fn>;
} {
  return {
    getId: () => "postgres",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
    close: vi.fn(closeImpl),
  };
}

function adapterNoClose(): DatabaseAdapter {
  return {
    getId: () => "null",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

function registry(record?: ConnectionRecord): ConnectionRegistry & {
  delete: ReturnType<typeof vi.fn>;
} {
  return {
    add: () => undefined,
    list: () => (record ? [record] : []),
    get: vi.fn((id) => (record?.id === id ? record : undefined)),
    delete: vi.fn().mockReturnValue(true),
  };
}

describe("DeleteConnection", () => {
  it("forwards to registry.delete for a known id", async () => {
    const r = registry({ id: "a", label: "x", driver: "null", adapter: adapterNoClose() });
    await new DeleteConnection(r).execute("a");
    expect(r.delete).toHaveBeenCalledWith("a");
  });

  it("is idempotent — does not throw when the id is unknown", async () => {
    const r = registry();
    r.delete = vi.fn().mockReturnValue(false);
    await expect(new DeleteConnection(r).execute("missing")).resolves.toBeUndefined();
  });

  it("closes the adapter before evicting it from the registry", async () => {
    const adapter = adapterWithClose();
    const r = registry({ id: "a", label: "Prod", driver: "postgres", adapter });
    await new DeleteConnection(r).execute("a");
    expect(adapter.close).toHaveBeenCalledOnce();
    expect(r.delete).toHaveBeenCalledWith("a");
  });

  it("swallows close() failures so the registry eviction still happens", async () => {
    const adapter = adapterWithClose(async () => {
      throw new Error("peer already hung up");
    });
    const r = registry({ id: "a", label: "x", driver: "postgres", adapter });
    await expect(new DeleteConnection(r).execute("a")).resolves.toBeUndefined();
    expect(r.delete).toHaveBeenCalledWith("a");
  });

  it("skips close() entirely when the adapter does not implement it (NullAdapter)", async () => {
    const r = registry({ id: "a", label: "x", driver: "null", adapter: adapterNoClose() });
    await expect(new DeleteConnection(r).execute("a")).resolves.toBeUndefined();
    expect(r.delete).toHaveBeenCalledWith("a");
  });
});
