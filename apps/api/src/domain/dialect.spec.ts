import { describe, expect, it } from "vitest";
import { DEFAULT_DIALECT, dialectFor, dialectForDriver } from "./dialect";

describe("dialectForDriver", () => {
  it("maps the SQLite-wire drivers onto the SQLite dialect", () => {
    // Both speak SQLite through an HTTP envelope, and the envelope has no
    // bearing on the SQL they accept — desktop's table groups them the same
    // way for the same reason.
    expect(dialectForDriver("turso")).toBe("sqlite");
    expect(dialectForDriver("d1")).toBe("sqlite");
  });

  it("maps the Postgres-family drivers onto the Postgres dialect", () => {
    // `neon`, `supabase` and `aurora-dsql` are in the table ahead of any
    // adapter that answers to them: they are desktop's names for hosted
    // Postgres, and a name that resolves before its adapter exists is what
    // keeps the two from being added out of order (ADR-0072).
    for (const driver of ["postgres", "neon", "supabase", "aurora-dsql"]) {
      expect(dialectForDriver(driver)).toBe("postgres");
    }
  });

  it("maps mysql onto the MySQL dialect", () => {
    expect(dialectForDriver("mysql")).toBe("mysql");
  });

  it("reports an unknown driver as unknown rather than guessing", () => {
    // The exact mirror of desktop's `dialect_for_adapter_id`, which returns
    // `Option`. The guess belongs in one place — `dialectFor` — and this
    // function exists so the drift test below can tell "not in the table"
    // apart from "in the table, resolved to the default".
    expect(dialectForDriver("mongo")).toBeNull();
    expect(dialectForDriver("")).toBeNull();
  });

  it("does not mistake an inherited object property for a driver", () => {
    // Same trap `StaticAdapterFactory.create` guards: the argument reaches
    // here from a driver string, and a plain object literal as the table
    // would answer `constructor` with a function.
    expect(dialectForDriver("constructor")).toBeNull();
    expect(dialectForDriver("toString")).toBeNull();
    expect(dialectForDriver("__proto__")).toBeNull();
  });

  // The "every factory driver has an entry" drift test lives in
  // `static-adapter-factory.spec.ts`, not here: `domain` does not import
  // `infrastructure`, and the factory is the side that would drift.
});

describe("dialectFor", () => {
  it("resolves a known driver the way the table says", () => {
    expect(dialectFor("mysql")).toBe("mysql");
    expect(dialectFor("d1")).toBe("sqlite");
    expect(dialectFor("postgres")).toBe("postgres");
  });

  it("falls back to ANSI for an unknown, absent or empty driver", () => {
    // ADR-0072 decision 1. ANSI is what every dialect but MySQL accepts for
    // an identifier, so it is the right guess for an adapter added after
    // the table — and the wrong guess is a syntax error, not a silently
    // wrong result. `postgres` is web's spelling of ANSI here because the
    // backend dialect also decides literals, and the Postgres arm is the
    // one every caller emitted before this seam existed.
    expect(dialectFor("mongo")).toBe(DEFAULT_DIALECT);
    expect(dialectFor(undefined)).toBe(DEFAULT_DIALECT);
    expect(dialectFor(null)).toBe(DEFAULT_DIALECT);
    expect(dialectFor("")).toBe(DEFAULT_DIALECT);
    expect(DEFAULT_DIALECT).toBe("postgres");
  });
});
