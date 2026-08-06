import { describe, expect, it } from "vitest";
import { CapabilityError } from "../domain/errors";
import { D1Adapter } from "./d1-adapter";
import { NullAdapter } from "./null-adapter";
import { PostgresAdapter } from "./postgres-adapter";
import { StaticAdapterFactory } from "./static-adapter-factory";
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
  null: {},
};

describe("StaticAdapterFactory", () => {
  it("returns a NullAdapter for the 'null' driver", () => {
    expect(new StaticAdapterFactory().create("null", {})).toBeInstanceOf(NullAdapter);
  });

  it("returns a PostgresAdapter for the 'postgres' driver with a connectionString", () => {
    // pg.Pool is lazy — no TCP connection opens until the first query —
    // so constructing the adapter against a non-resolvable host is safe.
    const adapter = new StaticAdapterFactory().create("postgres", {
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

  it("raises CapabilityError when the postgres driver is missing connection info", () => {
    expect(() => new StaticAdapterFactory().create("postgres", {})).toThrowError(CapabilityError);
  });

  it("returns a TursoAdapter for the 'turso' driver with a remote URL", () => {
    // `createClient` is lazy for the remote transports, so no socket opens.
    const adapter = new StaticAdapterFactory().create("turso", CONFIG_FOR["turso"]);
    try {
      expect(adapter).toBeInstanceOf(TursoAdapter);
      expect(adapter.getId()).toBe("turso");
    } finally {
      void adapter.close?.();
    }
  });

  it("raises CapabilityError when the turso driver is missing its URL", () => {
    expect(() => new StaticAdapterFactory().create("turso", {})).toThrowError(CapabilityError);
  });

  it("raises CapabilityError when the turso driver is pointed at a local file", () => {
    // The factory is what a request body reaches. A `file:` URL here would
    // open a file on the API host, so the refusal has to survive at this
    // level and not only in the adapter's own unit test.
    expect(() =>
      new StaticAdapterFactory().create("turso", { connectionString: "file:/etc/passwd" }),
    ).toThrowError(CapabilityError);
  });

  it("returns a D1Adapter for the 'd1' driver with both ids and a token", () => {
    // No socket opens here either: the transport is built around `fetch`
    // and nothing calls it until a query does.
    const adapter = new StaticAdapterFactory().create("d1", CONFIG_FOR["d1"]);
    expect(adapter).toBeInstanceOf(D1Adapter);
    expect(adapter.getId()).toBe("d1");
  });

  it("raises CapabilityError when the d1 driver is missing an id or its token", () => {
    const factory = new StaticAdapterFactory();
    // Three required fields and no URL to infer them from, so each absence
    // has to be refused here rather than surfacing as a 404 from Cloudflare
    // against a path with `undefined` in it.
    expect(() => factory.create("d1", {})).toThrowError(CapabilityError);
    expect(() => factory.create("d1", { accountId: "acct", authToken: "t" })).toThrowError(
      CapabilityError,
    );
    expect(() => factory.create("d1", { accountId: "acct", databaseId: "dbid" })).toThrowError(
      CapabilityError,
    );
  });

  it("raises CapabilityError when a d1 id would escape its path segment", () => {
    // The same class of refusal as turso's `file:` check, at the level a
    // request reaches: the ids are interpolated into an authenticated URL,
    // so `../..` would re-aim the call at another Cloudflare API.
    expect(() =>
      new StaticAdapterFactory().create("d1", {
        accountId: "../../zones",
        databaseId: "dbid",
        authToken: "t",
      }),
    ).toThrowError(CapabilityError);
  });

  it("raises CapabilityError for unknown drivers (404 at the HTTP layer)", () => {
    expect(() => new StaticAdapterFactory().create("mongo", {})).toThrowError(CapabilityError);
    expect(() => new StaticAdapterFactory().create("", {})).toThrowError(CapabilityError);
  });

  it("lists the drivers it supports, with the real ones first", () => {
    // The order is the order the form offers them, so the drivers that
    // reach a database lead and the do-nothing adapter trails.
    expect([...new StaticAdapterFactory().supported()]).toEqual([
      "postgres",
      "turso",
      "d1",
      "null",
    ]);
  });

  it("can create every driver it lists", () => {
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
      const adapter = factory.create(driver, config);
      try {
        expect(adapter.getId()).toBe(driver);
      } finally {
        void adapter.close?.();
      }
    }
  });

  describe("rebuild (0027 slice G)", () => {
    it("hands the postgres rebuild to the adapter being replaced", () => {
      // The factory does not read the credential to pass it on — it cannot,
      // there is no accessor. It asks the old adapter for its successor and
      // the secret stays inside the pair.
      const factory = new StaticAdapterFactory();
      const before = factory.create("postgres", {
        host: "127.0.0.1",
        port: 1,
        user: "u",
        password: "OLD-PW",
      });
      const after = factory.rebuild(before, "postgres", { host: "127.0.0.2", port: 1, user: "u" });
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

    it("carries a turso auth token forward when the edit omits it", () => {
      // Same promise ADR-0080 makes about the postgres password: web keeps
      // no keyring, so the only copy of a live connection's credential is
      // inside the adapter serving it. An edit that re-points the URL must
      // not silently drop the token and leave an unauthenticated adapter
      // that 401s on its first query.
      const factory = new StaticAdapterFactory();
      const before = factory.create("turso", {
        connectionString: "libsql://old.turso.io",
        authToken: "OLD-TOKEN",
      });
      const after = factory.rebuild(before, "turso", {
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

    it("replaces a turso auth token the edit does supply", () => {
      const factory = new StaticAdapterFactory();
      const before = factory.create("turso", {
        connectionString: "libsql://old.turso.io",
        authToken: "OLD-TOKEN",
      });
      const after = factory.rebuild(before, "turso", {
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

    it("treats a blank turso auth token as 'keep', the way a blank password is treated", () => {
      // The edit form never prefills a credential box, so it round-trips ""
      // for the one nobody typed in. Taking that literally would replace a
      // working token with an empty bearer header.
      const factory = new StaticAdapterFactory();
      const before = factory.create("turso", {
        connectionString: "libsql://old.turso.io",
        authToken: "OLD-TOKEN",
      });
      const after = factory.rebuild(before, "turso", {
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

    it("refuses a turso rebuild it cannot perform rather than returning a broken adapter", () => {
      const factory = new StaticAdapterFactory();
      const before = factory.create("turso", CONFIG_FOR["turso"]);
      try {
        expect(() =>
          factory.rebuild(before, "turso", { connectionString: ":memory:" }),
        ).toThrowError(CapabilityError);
      } finally {
        void before.close?.();
      }
    });

    it("rebuilds a driver that holds no credential without consulting the old one", () => {
      const factory = new StaticAdapterFactory();
      const before = factory.create("null", {});
      const after = factory.rebuild(before, "null", {});
      expect(after).toBeInstanceOf(NullAdapter);
      expect(after).not.toBe(before);
    });

    it("raises CapabilityError for an unknown driver, as create does", () => {
      const factory = new StaticAdapterFactory();
      const before = factory.create("null", {});
      expect(() => factory.rebuild(before, "mongo", {})).toThrowError(CapabilityError);
    });

    it("reports a rebuild it cannot perform rather than returning a broken adapter", () => {
      // Same validation `create` applies: a postgres config naming neither a
      // host nor a connectionString is refused. The use case relies on this
      // raising *before* it closes the old pool, so a rejected edit leaves
      // the connection working.
      const factory = new StaticAdapterFactory();
      const before = factory.create("postgres", { host: "127.0.0.1", port: 1 });
      try {
        expect(() => factory.rebuild(before, "postgres", {})).toThrowError(CapabilityError);
      } finally {
        void before.close?.();
      }
    });
  });

  it("does not mistake an inherited object property for a driver", () => {
    // A lookup table keyed by a caller-supplied string is one prototype
    // away from `create("constructor", …)` finding a function and calling
    // it. `driver` arrives from the request body, so this is reachable.
    expect(() => new StaticAdapterFactory().create("constructor", {})).toThrowError(
      CapabilityError,
    );
    expect(() => new StaticAdapterFactory().create("toString", {})).toThrowError(CapabilityError);
    expect(() => new StaticAdapterFactory().create("__proto__", {})).toThrowError(CapabilityError);
  });
});
