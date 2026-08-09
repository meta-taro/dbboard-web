import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import type { AdapterFactory } from "../usecase/adapter-factory.port";
import type { ConnectionRecord, ConnectionRegistry } from "../usecase/connection-registry.port";
import { DeleteConnection } from "../usecase/delete-connection.use-case";
import { ListConnections } from "../usecase/list-connections.use-case";
import { ListDrivers } from "../usecase/list-drivers.use-case";
import { ProbeSshHostKey } from "../usecase/probe-ssh-host-key.use-case";
import { RegisterConnection } from "../usecase/register-connection.use-case";
import type { SshHostKeyProbe } from "../usecase/ssh-host-key-probe.port";
import { UpdateConnection } from "../usecase/update-connection.use-case";
import { ConnectionsController } from "./connections.controller";

function adapter(): DatabaseAdapter {
  return {
    getId: () => "null",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

function factory(drivers: readonly string[] = ["null"]): AdapterFactory {
  return {
    create: async () => adapter(),
    rebuild: async () => adapter(),
    supported: () => drivers,
  };
}

function prober(fingerprint = `SHA256:${"A".repeat(43)}`): SshHostKeyProbe {
  return { probe: vi.fn().mockResolvedValue(fingerprint) };
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
  it("POST /connections returns the registered id", async () => {
    const reg = inMemRegistry();
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory(), () => "fixed-id"),
      new ListConnections(reg),
      new DeleteConnection(reg),
      new UpdateConnection(reg, factory()),
      new ListDrivers(factory()),
      new ProbeSshHostKey(prober()),
    );
    expect(await controller.register({ label: "Local", driver: "null" })).toEqual({
      id: "fixed-id",
    });
    expect(reg.list()).toHaveLength(1);
  });

  it("GET /connections returns the non-secret parts — no adapter, no credential", () => {
    // Extended in 0027 slice F, not replaced (baseline §7). The original
    // asserted the response was exactly `{ id, label, driver }`, which held
    // only because nothing was remembered about the connection; that is what
    // blocked the edit form (ADR-0080). The seeded record now carries parts,
    // so the assertion has something to be wrong about.
    const reg = inMemRegistry([
      { id: "1", label: "L", driver: "null", adapter: adapter() },
      {
        id: "2",
        label: "Prod",
        driver: "postgres",
        adapter: adapter(),
        parts: { host: "db.internal", port: 5432, database: "app", user: "reader" },
      },
    ]);
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory()),
      new ListConnections(reg),
      new DeleteConnection(reg),
      new UpdateConnection(reg, factory()),
      new ListDrivers(factory()),
      new ProbeSshHostKey(prober()),
    );
    const out = controller.list();

    expect(out).toEqual({
      connections: [
        { id: "1", label: "L", driver: "null" },
        {
          id: "2",
          label: "Prod",
          driver: "postgres",
          parts: { host: "db.internal", port: 5432, database: "app", user: "reader" },
        },
      ],
    });
    // The whole response, not one view: a credential leaking through a field
    // nobody thought to assert on is the failure mode this guards.
    const serialised = JSON.stringify(out);
    expect(serialised).not.toContain("password");
    expect(serialised).not.toContain("connectionString");
    expect(serialised).not.toContain("adapter");
  });

  it("DELETE /connections/:id is idempotent and does not throw on a missing id", async () => {
    const reg = inMemRegistry();
    const spy = vi.spyOn(reg, "delete");
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory()),
      new ListConnections(reg),
      new DeleteConnection(reg),
      new UpdateConnection(reg, factory()),
      new ListDrivers(factory()),
      new ProbeSshHostKey(prober()),
    );
    await expect(controller.remove("missing")).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalledWith("missing");
  });
  it("GET /connections/drivers reports the factory's list, not a copy of it", () => {
    // The form renders these as its `<option>`s. A driver missing here is a
    // driver the user cannot pick; a driver here that the factory cannot
    // build is a 404 on submit — the failure ADR-0074 is about.
    const reg = inMemRegistry();
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory()),
      new ListConnections(reg),
      new DeleteConnection(reg),
      new UpdateConnection(reg, factory()),
      new ListDrivers(factory(["postgres", "null"])),
      new ProbeSshHostKey(prober()),
    );
    expect(controller.drivers()).toEqual({ drivers: ["postgres", "null"] });
  });

  it("PATCH /connections/:id answers with the edited connection, still without a credential", async () => {
    const reg = inMemRegistry([
      {
        id: "2",
        label: "Prod",
        driver: "postgres",
        adapter: adapter(),
        parts: { host: "db.internal", port: 5432, database: "app", user: "reader" },
      },
    ]);
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory()),
      new ListConnections(reg),
      new DeleteConnection(reg),
      new UpdateConnection(reg, factory()),
      new ListDrivers(factory()),
      new ProbeSshHostKey(prober()),
    );

    const out = await controller.update("2", {
      label: "Staging",
      host: "staging.internal",
      port: 5432,
      database: "app",
      user: "reader",
      // The blank box the form submits for a password nobody retyped. It
      // has to survive the DTO and the controller to mean anything at the
      // layer that acts on it (ADR-0080).
      password: "",
    });

    expect(out).toEqual({
      id: "2",
      label: "Staging",
      driver: "postgres",
      parts: { host: "staging.internal", port: 5432, database: "app", user: "reader" },
    });
    expect(JSON.stringify(out)).not.toContain("password");
  });

  it("POST /connections/ssh/host-key answers with the key the bastion presented", async () => {
    // Desktop's `probe_ssh_host_key`, over HTTP (ADR-0076). An object
    // rather than the bare string desktop returns, so the response can
    // gain a field later without every client having to change.
    const probe = prober("SHA256:zzz");
    const controller = new ConnectionsController(
      new RegisterConnection(inMemRegistry(), factory(), () => "id"),
      new ListConnections(inMemRegistry()),
      new DeleteConnection(inMemRegistry()),
      new UpdateConnection(inMemRegistry(), factory()),
      new ListDrivers(factory()),
      new ProbeSshHostKey(probe),
    );

    expect(await controller.probeSshHostKey({ host: "bastion", port: 2222 })).toEqual({
      fingerprint: "SHA256:zzz",
    });
    expect(probe.probe).toHaveBeenCalledWith("bastion", 2222);
  });

  it("POST /connections/ssh/host-key registers nothing", async () => {
    // The half of ADR-0076 that is easy to lose. Fetching a fingerprint
    // fills a box for the operator to look at and save; it must not pin
    // anything by itself, or the confirmation step is trust-on-first-use
    // wearing a button.
    const reg = inMemRegistry();
    const controller = new ConnectionsController(
      new RegisterConnection(reg, factory(), () => "id"),
      new ListConnections(reg),
      new DeleteConnection(reg),
      new UpdateConnection(reg, factory()),
      new ListDrivers(factory()),
      new ProbeSshHostKey(prober()),
    );

    await controller.probeSshHostKey({ host: "bastion" });

    expect(reg.list()).toHaveLength(0);
  });
});
