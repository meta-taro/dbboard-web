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
});
