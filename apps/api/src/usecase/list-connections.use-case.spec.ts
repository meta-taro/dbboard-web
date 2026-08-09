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
  // Retitled in 0027 slice F: the projection now also carries `parts` when
  // the record has them (see below). What this test pins is unchanged — the
  // adapter instance, which holds the live credential, never crosses out.
  it("strips the adapter instance from every record it projects", () => {
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

  it("passes the stored parts through so an edit form can be prefilled", () => {
    const records: ConnectionRecord[] = [
      {
        id: "a",
        label: "Prod",
        driver: "postgres",
        adapter: adapter(),
        parts: { host: "db.internal", port: 5432, database: "app", user: "reader" },
      },
    ];
    const out = new ListConnections(registry(records)).execute();
    expect(out.connections[0]).toEqual({
      id: "a",
      label: "Prod",
      driver: "postgres",
      parts: { host: "db.internal", port: 5432, database: "app", user: "reader" },
    });
  });

  it("omits parts entirely for a record that has none", () => {
    const records: ConnectionRecord[] = [
      { id: "a", label: "Local", driver: "null", adapter: adapter() },
    ];
    expect(new ListConnections(registry(records)).execute().connections[0]).not.toHaveProperty(
      "parts",
    );
  });

  it("returns an empty list when nothing is registered", () => {
    expect(new ListConnections(registry([])).execute()).toEqual({ connections: [] });
  });

  it("carries the tunnel description into the view", () => {
    // The projection names every field it forwards, so a record field the
    // view forgot is silent — the sidebar simply never learns the connection
    // is tunnelled (0031 slice F).
    const ssh = {
      host: "bastion.example.com",
      port: 22,
      user: "deploy",
      auth: "password",
      hostKey: { kind: "fingerprint", fingerprint: "SHA256:abc" },
    } as const;
    const reg = registry([
      { id: "c1", label: "Prod", driver: "postgres", adapter: adapter(), ssh },
    ]);

    expect(new ListConnections(reg).execute().connections[0]?.ssh).toEqual(ssh);
  });
});
