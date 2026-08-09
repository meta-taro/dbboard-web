import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { dialectForDriver } from "../domain/dialect";
import { CapabilityError } from "../domain/errors";
import type { ForwardTarget, SshTunnelConfig } from "../domain/ssh";
import { D1Adapter } from "./d1-adapter";
import { MySqlAdapter } from "./mysql-adapter";
import { NullAdapter } from "./null-adapter";
import { PostgresAdapter } from "./postgres-adapter";
import type { SshTunnelHandle } from "./ssh-tunnel";
import { StaticAdapterFactory } from "./static-adapter-factory";
import { isTunneledAdapter } from "./tunneled-adapter";
import { TursoAdapter } from "./turso-adapter";

// A config each driver accepts. Until 0031 the anti-drift test below could
// hand every driver one postgres DSN, because there was only one driver
// that read the field. A second real driver ends that: `postgresql://…` is
// a scheme `createTursoAdapter` refuses, and a shared fixture would have
// made the drift test fail for a reason that has nothing to do with drift.
const CONFIG_FOR: Record<string, Record<string, unknown>> = {
  postgres: { connectionString: "postgresql://u:p@127.0.0.1:1/db" },
  turso: { connectionString: "libsql://db-org.turso.io", authToken: "token" },
  // D1 is addressed by two path ids rather than by a URL, which is the whole
  // reason `AdapterConfig` grew fields for them — a driver whose fixture
  // looks nothing like its neighbours' is the table earning its keep.
  d1: { accountId: "acct", databaseId: "dbid", authToken: "token" },
  // Back to a URL, and deliberately not postgres' one: the schemes are
  // disjoint in both directions, so this fixture also proves the two
  // URL-shaped drivers are not interchangeable.
  mysql: { connectionString: "mysql://u:p@127.0.0.1:3306/db" },
  null: {},
};

describe("StaticAdapterFactory", () => {
  it("returns a NullAdapter for the 'null' driver", async () => {
    expect(await new StaticAdapterFactory().create("null", {})).toBeInstanceOf(NullAdapter);
  });

  it("returns a PostgresAdapter for the 'postgres' driver with a connectionString", async () => {
    // pg.Pool is lazy — no TCP connection opens until the first query —
    // so constructing the adapter against a non-resolvable host is safe.
    const adapter = await new StaticAdapterFactory().create("postgres", {
      connectionString: "postgresql://u:p@127.0.0.1:1/db",
    });
    try {
      expect(adapter).toBeInstanceOf(PostgresAdapter);
      expect(adapter.getId()).toBe("postgres");
    } finally {
      // End the pool so vitest does not see open handles after the test.
      void adapter.close?.();
    }
  });

  it("raises CapabilityError when the postgres driver is missing connection info", async () => {
    await expect(new StaticAdapterFactory().create("postgres", {})).rejects.toThrowError(
      CapabilityError,
    );
  });

  it("returns a TursoAdapter for the 'turso' driver with a remote URL", async () => {
    // `createClient` is lazy for the remote transports, so no socket opens.
    const adapter = await new StaticAdapterFactory().create("turso", CONFIG_FOR["turso"]);
    try {
      expect(adapter).toBeInstanceOf(TursoAdapter);
      expect(adapter.getId()).toBe("turso");
    } finally {
      void adapter.close?.();
    }
  });

  it("raises CapabilityError when the turso driver is missing its URL", async () => {
    await expect(new StaticAdapterFactory().create("turso", {})).rejects.toThrowError(
      CapabilityError,
    );
  });

  it("raises CapabilityError when the turso driver is pointed at a local file", async () => {
    // The factory is what a request body reaches. A `file:` URL here would
    // open a file on the API host, so the refusal has to survive at this
    // level and not only in the adapter's own unit test.
    await expect(
      new StaticAdapterFactory().create("turso", { connectionString: "file:/etc/passwd" }),
    ).rejects.toThrowError(CapabilityError);
  });

  it("returns a D1Adapter for the 'd1' driver with both ids and a token", async () => {
    // No socket opens here either: the transport is built around `fetch`
    // and nothing calls it until a query does.
    const adapter = await new StaticAdapterFactory().create("d1", CONFIG_FOR["d1"]);
    expect(adapter).toBeInstanceOf(D1Adapter);
    expect(adapter.getId()).toBe("d1");
  });

  it("raises CapabilityError when the d1 driver is missing an id or its token", async () => {
    const factory = new StaticAdapterFactory();
    // Three required fields and no URL to infer them from, so each absence
    // has to be refused here rather than surfacing as a 404 from Cloudflare
    // against a path with `undefined` in it.
    await expect(factory.create("d1", {})).rejects.toThrowError(CapabilityError);
    await expect(factory.create("d1", { accountId: "acct", authToken: "t" })).rejects.toThrowError(
      CapabilityError,
    );
    await expect(
      factory.create("d1", { accountId: "acct", databaseId: "dbid" }),
    ).rejects.toThrowError(CapabilityError);
  });

  it("raises CapabilityError when a d1 id would escape its path segment", async () => {
    // The same class of refusal as turso's `file:` check, at the level a
    // request reaches: the ids are interpolated into an authenticated URL,
    // so `../..` would re-aim the call at another Cloudflare API.
    await expect(
      new StaticAdapterFactory().create("d1", {
        accountId: "../../zones",
        databaseId: "dbid",
        authToken: "t",
      }),
    ).rejects.toThrowError(CapabilityError);
  });

  it("returns a MySqlAdapter for the 'mysql' driver with a connectionString", async () => {
    // `createPool` is lazy the way `pg.Pool` is: the pool exists, no socket
    // does, so an unreachable host is safe to construct against.
    const adapter = await new StaticAdapterFactory().create("mysql", CONFIG_FOR["mysql"]);
    try {
      expect(adapter).toBeInstanceOf(MySqlAdapter);
      expect(adapter.getId()).toBe("mysql");
    } finally {
      void adapter.close?.();
    }
  });

  it("raises CapabilityError when the mysql driver is missing connection info", async () => {
    await expect(new StaticAdapterFactory().create("mysql", {})).rejects.toThrowError(
      CapabilityError,
    );
  });

  it("raises CapabilityError when the mysql driver is handed another engine's URL", async () => {
    // The mirror of turso's `file:` refusal, and the reason `CONFIG_FOR`
    // stopped sharing one DSN: a postgres URL reaching the mysql builder is
    // a mis-set driver field, and it has to be a 404 rather than a pool
    // quietly dialling 5432 with the wrong protocol.
    await expect(
      new StaticAdapterFactory().create("mysql", {
        connectionString: "postgresql://u:p@127.0.0.1:5432/db",
      }),
    ).rejects.toThrowError(CapabilityError);
  });

  it("raises CapabilityError for unknown drivers (404 at the HTTP layer)", async () => {
    await expect(new StaticAdapterFactory().create("mongo", {})).rejects.toThrowError(
      CapabilityError,
    );
    await expect(new StaticAdapterFactory().create("", {})).rejects.toThrowError(CapabilityError);
  });

  it("lists the drivers it supports, with the real ones first", () => {
    // The order is the order the form offers them, so the drivers that
    // reach a database lead and the do-nothing adapter trails.
    expect([...new StaticAdapterFactory().supported()]).toEqual([
      "postgres",
      "turso",
      "d1",
      "mysql",
      "null",
    ]);
  });

  it("can create every driver it lists", async () => {
    // The anti-drift test. `supported()` exists so the form stops restating
    // the driver list from memory; it is only worth trusting if a name on
    // that list is a name `create` accepts. Both read one table, and this
    // fails if a future edit gives them two.
    const factory = new StaticAdapterFactory();
    for (const driver of factory.supported()) {
      const config = CONFIG_FOR[driver];
      // A driver added to the table without a fixture here would otherwise
      // be tested with `undefined` and pass by accident.
      expect(config, `no fixture config for driver "${driver}"`).toBeDefined();
      const adapter = await factory.create(driver, config);
      try {
        expect(adapter.getId()).toBe(driver);
      } finally {
        void adapter.close?.();
      }
    }
  });

  it("has a dialect for every driver it lists", () => {
    // The second anti-drift test, and the one with a bug behind it. Slice B
    // added `d1` — a SQLite-wire driver that advertises `has_table_ddl`, so
    // it can be dumped — while the dump path still rendered every blob as
    // `'\xHEX'::bytea`. That is Postgres syntax SQLite cannot read, and
    // nothing failed, because a driver missing from the dialect table
    // silently inherits the ANSI fallback. The fallback is only right for
    // identifiers; literals it gets wrong quietly.
    for (const driver of new StaticAdapterFactory().supported()) {
      expect(dialectForDriver(driver), `no dialect for driver "${driver}"`).not.toBeNull();
    }
  });

  describe("rebuild (0027 slice G)", () => {
    it("hands the postgres rebuild to the adapter being replaced", async () => {
      // The factory does not read the credential to pass it on — it cannot,
      // there is no accessor. It asks the old adapter for its successor and
      // the secret stays inside the pair.
      const factory = new StaticAdapterFactory();
      const before = await factory.create("postgres", {
        host: "127.0.0.1",
        port: 1,
        user: "u",
        password: "OLD-PW",
      });
      const after = await factory.rebuild(before, "postgres", {
        host: "127.0.0.2",
        port: 1,
        user: "u",
      });
      try {
        expect(after).toBeInstanceOf(PostgresAdapter);
        expect(after).not.toBe(before);
        expect(
          (after as unknown as { pool: { options: Record<string, unknown> } }).pool.options,
        ).toMatchObject({ host: "127.0.0.2", password: "OLD-PW" });
      } finally {
        void before.close?.();
        void after.close?.();
      }
    });

    it("carries a turso auth token forward when the edit omits it", async () => {
      // Same promise ADR-0080 makes about the postgres password: web keeps
      // no keyring, so the only copy of a live connection's credential is
      // inside the adapter serving it. An edit that re-points the URL must
      // not silently drop the token and leave an unauthenticated adapter
      // that 401s on its first query.
      const factory = new StaticAdapterFactory();
      const before = await factory.create("turso", {
        connectionString: "libsql://old.turso.io",
        authToken: "OLD-TOKEN",
      });
      const after = await factory.rebuild(before, "turso", {
        connectionString: "libsql://new.turso.io",
      });
      try {
        expect(after).toBeInstanceOf(TursoAdapter);
        expect(after).not.toBe(before);
        expect((after as unknown as { secret?: string }).secret).toBe("OLD-TOKEN");
      } finally {
        void before.close?.();
        void after.close?.();
      }
    });

    it("replaces a turso auth token the edit does supply", async () => {
      const factory = new StaticAdapterFactory();
      const before = await factory.create("turso", {
        connectionString: "libsql://old.turso.io",
        authToken: "OLD-TOKEN",
      });
      const after = await factory.rebuild(before, "turso", {
        connectionString: "libsql://new.turso.io",
        authToken: "NEW-TOKEN",
      });
      try {
        expect((after as unknown as { secret?: string }).secret).toBe("NEW-TOKEN");
      } finally {
        void before.close?.();
        void after.close?.();
      }
    });

    it("treats a blank turso auth token as 'keep', the way a blank password is treated", async () => {
      // The edit form never prefills a credential box, so it round-trips ""
      // for the one nobody typed in. Taking that literally would replace a
      // working token with an empty bearer header.
      const factory = new StaticAdapterFactory();
      const before = await factory.create("turso", {
        connectionString: "libsql://old.turso.io",
        authToken: "OLD-TOKEN",
      });
      const after = await factory.rebuild(before, "turso", {
        connectionString: "libsql://new.turso.io",
        authToken: "",
      });
      try {
        expect((after as unknown as { secret?: string }).secret).toBe("OLD-TOKEN");
      } finally {
        void before.close?.();
        void after.close?.();
      }
    });

    it("refuses a turso rebuild it cannot perform rather than returning a broken adapter", async () => {
      const factory = new StaticAdapterFactory();
      const before = await factory.create("turso", CONFIG_FOR["turso"]);
      try {
        await expect(
          factory.rebuild(before, "turso", { connectionString: ":memory:" }),
        ).rejects.toThrowError(CapabilityError);
      } finally {
        void before.close?.();
      }
    });

    it("carries a mysql password forward when the edited URL omits it", async () => {
      // MySQL's credential lives where postgres' does when it arrives as a
      // DSN — inside the URL — so the carry has to happen at that level:
      // re-point the host, keep the userinfo the edit dropped.
      const factory = new StaticAdapterFactory();
      const before = await factory.create("mysql", {
        connectionString: "mysql://u:OLD-PW@127.0.0.1:3306/db",
      });
      const after = await factory.rebuild(before, "mysql", {
        connectionString: "mysql://u@127.0.0.2:3306/db",
      });
      try {
        expect(after).toBeInstanceOf(MySqlAdapter);
        expect(after).not.toBe(before);
        expect((after as unknown as { secret?: string }).secret).toBe("OLD-PW");
      } finally {
        void before.close?.();
        void after.close?.();
      }
    });

    it("rebuilds a driver that holds no credential without consulting the old one", async () => {
      const factory = new StaticAdapterFactory();
      const before = await factory.create("null", {});
      const after = await factory.rebuild(before, "null", {});
      expect(after).toBeInstanceOf(NullAdapter);
      expect(after).not.toBe(before);
    });

    it("raises CapabilityError for an unknown driver, as create does", async () => {
      const factory = new StaticAdapterFactory();
      const before = await factory.create("null", {});
      await expect(factory.rebuild(before, "mongo", {})).rejects.toThrowError(CapabilityError);
    });

    it("reports a rebuild it cannot perform rather than returning a broken adapter", async () => {
      // Same validation `create` applies: a postgres config naming neither a
      // host nor a connectionString is refused. The use case relies on this
      // raising *before* it closes the old pool, so a rejected edit leaves
      // the connection working.
      const factory = new StaticAdapterFactory();
      const before = await factory.create("postgres", { host: "127.0.0.1", port: 1 });
      try {
        await expect(factory.rebuild(before, "postgres", {})).rejects.toThrowError(CapabilityError);
      } finally {
        void before.close?.();
      }
    });
  });

  describe("ssh tunnel (0031 slice D)", () => {
    // The *input* shape — flat, every field `unknown`, as it arrives in a
    // request body. `resolveSshTunnelConfig` is what turns it into the tagged
    // `auth` / `hostKey` pair the transport reads.
    const SSH = {
      host: "bastion.example.com",
      user: "jump",
      password: "pw",
      fingerprint: `SHA256:${"A".repeat(43)}`,
    };

    /** Records what was asked for, and hands back a forward on a fixed port. */
    function tunnelSpy(localPort = 15_432) {
      const opened: Array<{ config: SshTunnelConfig; target: ForwardTarget }> = [];
      const handle = { localPort, close: vi.fn(async () => undefined) };
      const openTunnel = vi.fn(async (config: SshTunnelConfig, target: ForwardTarget) => {
        opened.push({ config, target });
        return handle as SshTunnelHandle;
      });
      return { opened, handle, openTunnel };
    }

    it("refuses a tunnel on a driver that has no TCP port to forward", async () => {
      // Desktop refuses the same set structurally, in `supports_ssh_tunnel`.
      // Ignoring the block instead would leave the operator believing a
      // connection is private when it is not.
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      for (const driver of ["turso", "d1", "null"]) {
        await expect(
          factory.create(driver, { ...CONFIG_FOR[driver], ssh: SSH }),
        ).rejects.toThrowError(CapabilityError);
      }
      expect(spy.openTunnel).not.toHaveBeenCalled();
    });

    it("forwards to the host and port named in the connection string", async () => {
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const adapter = await factory.create("postgres", {
        connectionString: "postgresql://u:p@db.internal:6543/app",
        ssh: SSH,
      });
      try {
        expect(spy.opened[0]?.target).toEqual({ host: "db.internal", port: 6543 });
        expect(spy.opened[0]?.config.host).toBe("bastion.example.com");
      } finally {
        await adapter.close?.();
      }
    });

    it("defaults the far-side port per driver when the connection names none", async () => {
      const spy = tunnelSpy();
      const pg = await new StaticAdapterFactory({ openTunnel: spy.openTunnel }).create("postgres", {
        host: "pg.internal",
        user: "u",
        ssh: SSH,
      });
      const my = await new StaticAdapterFactory({ openTunnel: spy.openTunnel }).create("mysql", {
        connectionString: "mysql://u:p@my.internal/app",
        ssh: SSH,
      });
      try {
        expect(spy.opened.map((o) => o.target)).toEqual([
          { host: "pg.internal", port: 5432 },
          { host: "my.internal", port: 3306 },
        ]);
      } finally {
        await pg.close?.();
        await my.close?.();
      }
    });

    it("builds the driver against the local end of the forward", async () => {
      const spy = tunnelSpy(15_999);
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const adapter = await factory.create("postgres", {
        host: "db.internal",
        port: 6543,
        user: "u",
        password: "pw",
        ssh: SSH,
      });
      try {
        // Nothing may still name the far side: a field the driver reads is a
        // path around the tunnel.
        expect(poolOptions(adapter)).toMatchObject({ host: "127.0.0.1", port: 15_999 });
      } finally {
        await adapter.close?.();
      }
    });

    it("does not hand the ssh block to the driver", async () => {
      // It is not a driver setting, and pg passes unknown options through to
      // the connection parameters.
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const adapter = await factory.create("postgres", {
        host: "db.internal",
        user: "u",
        ssh: SSH,
      });
      try {
        expect(poolOptions(adapter)).not.toHaveProperty("ssh");
      } finally {
        await adapter.close?.();
      }
    });

    it("closes the forward when the adapter is closed", async () => {
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const adapter = await factory.create("postgres", {
        host: "db.internal",
        user: "u",
        ssh: SSH,
      });
      await adapter.close?.();

      expect(spy.handle.close).toHaveBeenCalled();
    });

    it("raises CapabilityError when the connection names no host to forward to", async () => {
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      // Matched on the message, not just the class: postgres refuses a
      // host-less config on its own, so a bare `toThrowError(CapabilityError)`
      // here would pass even if the tunnel path never ran.
      await expect(factory.create("postgres", { user: "u", ssh: SSH })).rejects.toThrowError(
        /forward to/,
      );
      expect(spy.openTunnel).not.toHaveBeenCalled();
    });

    it("raises CapabilityError for a malformed tunnel config, before dialling", async () => {
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      await expect(
        factory.create("postgres", {
          host: "db.internal",
          user: "u",
          // A tunnel naming neither a fingerprint nor a `known_hosts` is the
          // blind-accept case ADR-0069 refuses to have, and the one that most
          // needs to be refused *here*: reaching the transport, it would be a
          // connection to an unverified bastion.
          ssh: { ...SSH, fingerprint: undefined },
        }),
      ).rejects.toThrowError(CapabilityError);
      expect(spy.openTunnel).not.toHaveBeenCalled();
    });

    it("keeps the credential an edit omits when rebuilding through a fresh forward", async () => {
      // The reason `rebuild` unwraps: a TunneledAdapter is not a
      // PostgresAdapter, so dispatching on the wrapper would miss the
      // `instanceof` and quietly build a passwordless pool.
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const before = await factory.create("postgres", {
        host: "old.internal",
        user: "u",
        password: "OLD-PW",
        ssh: SSH,
      });
      const after = await factory.rebuild(before, "postgres", {
        host: "new.internal",
        user: "u",
        ssh: SSH,
      });
      try {
        expect(spy.opened.map((o) => o.target.host)).toEqual(["old.internal", "new.internal"]);
        expect(poolOptions(after)).toMatchObject({ host: "127.0.0.1", password: "OLD-PW" });
      } finally {
        await before.close?.();
        await after.close?.();
      }
    });

    it("gives back a direct adapter when an edit explicitly drops the tunnel", async () => {
      // `null`, not absence (0031 slice F2). Absence is what a PATCH body
      // that is about something else looks like — see the next case.
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const before = await factory.create("postgres", {
        host: "db.internal",
        user: "u",
        password: "OLD-PW",
        ssh: SSH,
      });
      const after = await factory.rebuild(before, "postgres", {
        host: "db.internal",
        user: "u",
        ssh: null,
      });
      try {
        expect(after).toBeInstanceOf(PostgresAdapter);
        // Still the far-side host, and still the password: dropping the
        // bastion is not dropping the credential.
        expect(poolOptions(after)).toMatchObject({ host: "db.internal", password: "OLD-PW" });
      } finally {
        await before.close?.();
        await after.close?.();
      }
    });

    it("keeps the bastion, and its credential, through an edit that says nothing about it", async () => {
      // 0031 slice F2, desktop `SshEditInput::Keep`. An edit that only moves
      // the database host carries no ssh block — the form cannot re-send the
      // bastion password it never received — so absence has to mean keep.
      // Read as "no tunnel", renaming a connection would put it straight on
      // the database it was tunnelling to reach.
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const before = await factory.create("postgres", {
        host: "old.internal",
        user: "u",
        password: "OLD-PW",
        ssh: SSH,
      });
      const after = await factory.rebuild(before, "postgres", { host: "new.internal", user: "u" });
      try {
        expect(isTunneledAdapter(after)).toBe(true);
        expect(spy.opened.map((o) => o.target.host)).toEqual(["old.internal", "new.internal"]);
        // The same bastion, dialled with the credential nobody re-typed.
        expect(spy.opened.map((o) => o.config.auth)).toEqual([
          { kind: "password", password: "pw" },
          { kind: "password", password: "pw" },
        ]);
      } finally {
        await before.close?.();
        await after.close?.();
      }
    });

    it("describes the tunnel it built, and describes none for a direct connection", async () => {
      // What the registry stores. Asked of the factory rather than derived
      // from the config, because after a carried edit the config no longer
      // says which credential the tunnel is on.
      const spy = tunnelSpy();
      const factory = new StaticAdapterFactory({ openTunnel: spy.openTunnel });

      const tunneled = await factory.create("postgres", {
        host: "db.internal",
        user: "u",
        ssh: SSH,
      });
      const direct = await factory.create("postgres", { host: "db.internal", user: "u" });
      try {
        expect(factory.describeTunnel(tunneled)).toEqual({
          host: "bastion.example.com",
          port: 22,
          user: "jump",
          auth: "password",
          hostKey: { kind: "fingerprint", fingerprint: `SHA256:${"A".repeat(43)}` },
        });
        expect(factory.describeTunnel(direct)).toBeUndefined();
      } finally {
        await tunneled.close?.();
        await direct.close?.();
      }
    });
  });

  it("does not mistake an inherited object property for a driver", async () => {
    // A lookup table keyed by a caller-supplied string is one prototype
    // away from `create("constructor", …)` finding a function and calling
    // it. `driver` arrives from the request body, so this is reachable.
    const factory = new StaticAdapterFactory();
    await expect(factory.create("constructor", {})).rejects.toThrowError(CapabilityError);
    await expect(factory.create("toString", {})).rejects.toThrowError(CapabilityError);
    await expect(factory.create("__proto__", {})).rejects.toThrowError(CapabilityError);
  });
});

/**
 * The pg options the adapter was built with — where the tunnel is visible.
 *
 * Looks through the wrapper, because that is the point: a tunneled adapter
 * delegates to a driver, and what the tunnel changed is what the *driver* was
 * handed. Written to accept either so the direct and tunneled cases can be
 * asserted the same way.
 */
function poolOptions(adapter: DatabaseAdapter): Record<string, unknown> {
  const driver = isTunneledAdapter(adapter) ? adapter.unwrap() : adapter;
  return (driver as unknown as { pool: { options: Record<string, unknown> } }).pool.options;
}
