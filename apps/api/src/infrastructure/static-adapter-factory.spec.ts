import { describe, expect, it } from "vitest";
import { CapabilityError } from "../domain/errors";
import { NullAdapter } from "./null-adapter";
import { PostgresAdapter } from "./postgres-adapter";
import { StaticAdapterFactory } from "./static-adapter-factory";

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

  it("raises CapabilityError for unknown drivers (404 at the HTTP layer)", () => {
    expect(() => new StaticAdapterFactory().create("mongo", {})).toThrowError(CapabilityError);
    expect(() => new StaticAdapterFactory().create("", {})).toThrowError(CapabilityError);
  });

  it("lists the drivers it supports, with the real one first", () => {
    // The order is the order the form offers them, so `postgres` leads and
    // the do-nothing adapter trails.
    expect([...new StaticAdapterFactory().supported()]).toEqual(["postgres", "null"]);
  });

  it("can create every driver it lists", () => {
    // The anti-drift test. `supported()` exists so the form stops restating
    // the driver list from memory; it is only worth trusting if a name on
    // that list is a name `create` accepts. Both read one table, and this
    // fails if a future edit gives them two.
    const factory = new StaticAdapterFactory();
    for (const driver of factory.supported()) {
      const adapter = factory.create(driver, {
        connectionString: "postgresql://u:p@127.0.0.1:1/db",
      });
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
