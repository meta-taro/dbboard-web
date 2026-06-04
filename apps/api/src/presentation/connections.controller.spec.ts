import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { AdapterFactory } from "../usecase/adapter-factory.port";
import type { ConnectionRecord, ConnectionRegistry } from "../usecase/connection-registry.port";
import { DeleteConnection } from "../usecase/delete-connection.use-case";
import { ListConnections } from "../usecase/list-connections.use-case";
import { RegisterConnection } from "../usecase/register-connection.use-case";
import { ConnectionsController } from "./connections.controller";

function adapter(): DatabaseAdapter {
  return {
    getId: () => "null",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

function factory(): AdapterFactory {
  return { create: () => adapter() };
}

function inMemRegistry(seed: ConnectionRecord[] = []): ConnectionRegistry {
  const store = new Map(seed.map((r) => [r.id, r]));
  return {
    add: (r) => {
      store.set(r.id, r);
    },
    list: () => Array.from(store.values()),
    get: (id) => store.get(id),
    delete: (id) => store.delete(id),
  };
}

describe("ConnectionsController", () => {
  it("POST /connections returns the registered id", () => {
    const reg = inMemRegistry();
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory(), () => "fixed-id"),
      new ListConnections(reg),
      new DeleteConnection(reg),
    );
    expect(controller.register({ label: "Local", driver: "null" })).toEqual({ id: "fixed-id" });
    expect(reg.list()).toHaveLength(1);
  });

  it("GET /connections returns id/label/driver only — no adapter / no secrets", () => {
    const reg = inMemRegistry([{ id: "1", label: "L", driver: "null", adapter: adapter() }]);
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory()),
      new ListConnections(reg),
      new DeleteConnection(reg),
    );
    const out = controller.list();
    expect(out).toEqual({ connections: [{ id: "1", label: "L", driver: "null" }] });
  });

  it("DELETE /connections/:id is idempotent and does not throw on a missing id", () => {
    const reg = inMemRegistry();
    const spy = vi.spyOn(reg, "delete");
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory()),
      new ListConnections(reg),
      new DeleteConnection(reg),
    );
    expect(() => controller.remove("missing")).not.toThrow();
    expect(spy).toHaveBeenCalledWith("missing");
  });
});
