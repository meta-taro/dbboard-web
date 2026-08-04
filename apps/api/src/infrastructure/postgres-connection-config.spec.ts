import { describe, expect, it } from "vitest";
import {
  resolvePostgresPoolOptions,
  type PostgresConnectionConfig,
} from "./postgres-connection-config";

// Helper for the connectionString path — sslmode is exposed on the result
// object (not in the URL) so the adapter controls SSL via the explicit
// PoolConfig.ssl field, never via the URL's query params.
function sslmodeFor(connectionString: string): string | undefined {
  return resolvePostgresPoolOptions({ connectionString }).sslmode;
}

describe("resolvePostgresPoolOptions — defaults", () => {
  it("sets pool size 4 and idle timeout 30s (per 0004 § Connection registry wiring)", () => {
    const opts = resolvePostgresPoolOptions({
      connectionString: "postgresql://u:p@host.example.com:5432/db",
    });
    expect(opts.max).toBe(4);
    expect(opts.idleTimeoutMillis).toBe(30_000);
  });

  // pg's `query_timeout` is a client-side setTimeout (pg@8.21.0
  // lib/client.js:654) — it stops the caller waiting but sends nothing to
  // the server, so an over-budget statement keeps running and, outside an
  // explicit transaction, still commits. `statement_timeout` goes into the
  // startup packet (lib/client.js:543) and makes the server abort. We keep
  // both: they fail in different places and neither subsumes the other.
  // Mirrors desktop ADR-0081; see 0024 § invariant 3.
  it("defaults the server-side statement_timeout to 30s", () => {
    const opts = resolvePostgresPoolOptions({
      connectionString: "postgresql://u:p@host.example.com:5432/db",
    });
    expect(opts.statement_timeout).toBe(30_000);
  });

  it("honours an explicit statementTimeoutMs override", () => {
    const opts = resolvePostgresPoolOptions({
      connectionString: "postgresql://u:p@host.example.com:5432/db",
      statementTimeoutMs: 5_000,
    });
    expect(opts.statement_timeout).toBe(5_000);
  });

  // The client timer is the backstop, so it must not beat the server to the
  // punch. Given the same budget, both fire at once and whichever wins is a
  // coin toss — and when the client wins, the user is told "Query read
  // timeout" instead of the server's specific "canceling statement due to
  // statement timeout", losing the SQLSTATE with it. The grace is one round
  // trip's worth of head start for the server's error reply.
  it("gives the client timer a grace period past the server's budget", () => {
    const opts = resolvePostgresPoolOptions({
      connectionString: "postgresql://u:p@host.example.com:5432/db",
      statementTimeoutMs: 5_000,
    });
    expect(opts.query_timeout).toBe(7_000);
    expect(opts.query_timeout).toBeGreaterThan(opts.statement_timeout);
  });

  it("applies the same grace to the default budget", () => {
    const opts = resolvePostgresPoolOptions({
      connectionString: "postgresql://u:p@host.example.com:5432/db",
    });
    expect(opts.query_timeout).toBe(32_000);
  });

  it("sets both timeouts on the split-fields path as well", () => {
    const opts = resolvePostgresPoolOptions({
      host: "plain.example.com",
      database: "app",
      user: "u",
      password: "p",
      statementTimeoutMs: 7_500,
    });
    expect(opts.statement_timeout).toBe(7_500);
    expect(opts.query_timeout).toBe(9_500);
  });
});

describe("resolvePostgresPoolOptions — connectionString path", () => {
  it("defaults sslmode to 'prefer' when not specified", () => {
    expect(sslmodeFor("postgresql://u:p@plain.example.com:5432/db")).toBe("prefer");
  });

  it("preserves a caller-specified sslmode on plain hosts", () => {
    expect(sslmodeFor("postgresql://u:p@plain.example.com:5432/db?sslmode=disable")).toBe(
      "disable",
    );
  });

  it("auto-upgrades to 'require' for *.neon.tech regardless of input", () => {
    expect(sslmodeFor("postgresql://u:p@ep-aaa-123-pooler.us-east-2.aws.neon.tech:5432/db")).toBe(
      "require",
    );
  });

  it("auto-upgrades to 'require' for *.neon.tech even if caller passed sslmode=disable", () => {
    expect(
      sslmodeFor("postgresql://u:p@ep-aaa-123.us-east-2.aws.neon.tech:5432/db?sslmode=disable"),
    ).toBe("require");
  });

  it("auto-upgrades to 'require' for *.supabase.co", () => {
    expect(sslmodeFor("postgresql://u:p@db.abcdefg.supabase.co:5432/postgres")).toBe("require");
  });

  it("strips sslmode from the URL so the explicit PoolConfig.ssl field owns SSL routing", () => {
    const opts = resolvePostgresPoolOptions({
      connectionString: "postgresql://u:p@plain.example.com:5432/db?sslmode=prefer",
    });
    expect(opts.connectionString).toBeDefined();
    expect(new URL(opts.connectionString!).searchParams.has("sslmode")).toBe(false);
  });
});

describe("resolvePostgresPoolOptions — split-fields path", () => {
  const base: PostgresConnectionConfig = {
    host: "plain.example.com",
    port: 5432,
    database: "app",
    user: "u",
    password: "p",
  };

  it("maps split fields onto pg.PoolConfig", () => {
    const opts = resolvePostgresPoolOptions(base);
    expect(opts.host).toBe("plain.example.com");
    expect(opts.port).toBe(5432);
    expect(opts.database).toBe("app");
    expect(opts.user).toBe("u");
    expect(opts.password).toBe("p");
    expect(opts.connectionString).toBeUndefined();
  });

  it("defaults sslmode to 'prefer' on plain hosts", () => {
    const opts = resolvePostgresPoolOptions(base);
    // pg's PoolConfig encodes ssl=false|'prefer'|'require'|… via the `ssl`
    // field, NOT a sslmode query param. We surface the resolved mode under
    // a stable key so the integration layer doesn't need to keep these
    // two encodings in sync.
    expect(opts.sslmode).toBe("prefer");
  });

  it("auto-upgrades sslmode to 'require' on *.neon.tech", () => {
    const opts = resolvePostgresPoolOptions({
      ...base,
      host: "ep-xyz.us-east-2.aws.neon.tech",
    });
    expect(opts.sslmode).toBe("require");
  });

  it("auto-upgrades sslmode to 'require' on *.supabase.co", () => {
    const opts = resolvePostgresPoolOptions({
      ...base,
      host: "db.abcdefg.supabase.co",
    });
    expect(opts.sslmode).toBe("require");
  });
});

describe("resolvePostgresPoolOptions — input validation", () => {
  it("throws when neither connectionString nor host is provided", () => {
    expect(() => resolvePostgresPoolOptions({})).toThrowError(/connection/i);
  });
});
