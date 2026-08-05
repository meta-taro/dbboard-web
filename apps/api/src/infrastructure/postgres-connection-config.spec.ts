import { describe, expect, it } from "vitest";
import {
  resolvePostgresPoolOptions,
  type PostgresConnectionConfig,
} from "./postgres-connection-config";

// Helper for the connectionString path — sslmode is exposed on the result
// object (not in the URL) so the adapter controls SSL via the explicit
// PoolConfig.ssl field, never via the URL's query params.
function sslmodeFor(
  connectionString: string,
  rest: Omit<PostgresConnectionConfig, "connectionString"> = {},
): string | undefined {
  return resolvePostgresPoolOptions({ connectionString, ...rest }).sslmode;
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
  it("defaults sslmode to 'require' when not specified (ADR-0078)", () => {
    // Was 'prefer' until 0027 slice A. `prefer` reached
    // `createPostgresAdapter` as `ssl: false`, so an unqualified URL
    // connected in plaintext without ever attempting TLS. Desktop's
    // `harden_ssl_mode` rewrites the unspecified default up to Required on
    // the ground that a connection the user believes is encrypted and is
    // not is worse than one they knowingly turned off.
    expect(sslmodeFor("postgresql://u:p@plain.example.com:5432/db")).toBe("require");
  });

  it("rewrites an explicit sslmode=prefer up to 'require'", () => {
    // `prefer` is the plaintext-fallback mode. Desktop refuses to offer it
    // at all (ADR-0078 Decision 2); honouring it here would leave the one
    // spelling that still silently downgrades.
    expect(sslmodeFor("postgresql://u:p@plain.example.com:5432/db?sslmode=prefer")).toBe("require");
  });

  it("preserves a caller-specified sslmode on plain hosts", () => {
    expect(sslmodeFor("postgresql://u:p@plain.example.com:5432/db?sslmode=disable")).toBe(
      "disable",
    );
  });

  it("requires TLS for *.neon.tech, as it does everywhere", () => {
    expect(sslmodeFor("postgresql://u:p@ep-aaa-123-pooler.us-east-2.aws.neon.tech:5432/db")).toBe(
      "require",
    );
  });

  it("honours sslmode=disable on *.neon.tech rather than overriding it", () => {
    // The inverse of what this pinned before 0027 slice A. The old
    // host-suffix override existed to force TLS on hosts that need it —
    // which the new default already does. All it could still do was
    // contradict an explicit choice, and a knowing opt-out outranks a guess
    // made from a hostname. Neon will refuse the plaintext connection
    // itself, which tells the user more than us quietly disagreeing.
    expect(
      sslmodeFor("postgresql://u:p@ep-aaa-123.us-east-2.aws.neon.tech:5432/db?sslmode=disable"),
    ).toBe("disable");
  });

  it("requires TLS for *.supabase.co", () => {
    expect(sslmodeFor("postgresql://u:p@db.abcdefg.supabase.co:5432/postgres")).toBe("require");
  });

  it("strips sslmode from the URL so the explicit PoolConfig.ssl field owns SSL routing", () => {
    const opts = resolvePostgresPoolOptions({
      connectionString: "postgresql://u:p@plain.example.com:5432/db?sslmode=disable",
    });
    expect(opts.connectionString).toBeDefined();
    expect(new URL(opts.connectionString!).searchParams.has("sslmode")).toBe(false);
  });

  it("takes an explicit sslMode over anything the URL says", () => {
    // Slice B sends the form's TLS select as a field. It has to win over a
    // stale parameter in a URL the user also edited, or the select would be
    // reporting a choice it does not make.
    expect(
      sslmodeFor("postgresql://u:p@plain.example.com:5432/db?sslmode=disable", {
        sslMode: "require",
      }),
    ).toBe("require");
    expect(sslmodeFor("postgresql://u:p@plain.example.com:5432/db", { sslMode: "disable" })).toBe(
      "disable",
    );
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

  it("defaults sslmode to 'require' on plain hosts (ADR-0078)", () => {
    const opts = resolvePostgresPoolOptions(base);
    // pg's PoolConfig encodes ssl=false|'require'|… via the `ssl` field,
    // NOT a sslmode query param. We surface the resolved mode under a
    // stable key so the integration layer doesn't need to keep these two
    // encodings in sync.
    expect(opts.sslmode).toBe("require");
  });

  it("requires TLS on *.neon.tech, as it does everywhere", () => {
    const opts = resolvePostgresPoolOptions({
      ...base,
      host: "ep-xyz.us-east-2.aws.neon.tech",
    });
    expect(opts.sslmode).toBe("require");
  });

  it("requires TLS on *.supabase.co", () => {
    const opts = resolvePostgresPoolOptions({
      ...base,
      host: "db.abcdefg.supabase.co",
    });
    expect(opts.sslmode).toBe("require");
  });

  it("turns TLS off on the split-fields path only when asked explicitly", () => {
    // The parts path composes no URL, so there is nowhere to write
    // `sslmode=disable`. Without a field the form's Disabled option would
    // be unreachable for exactly the setup that most needs it — a tunnelled
    // or loopback server with TLS never configured (ADR-0078 § Context).
    const opts = resolvePostgresPoolOptions({ ...base, sslMode: "disable" });
    expect(opts.sslmode).toBe("disable");
  });
});

describe("resolvePostgresPoolOptions — input validation", () => {
  it("throws when neither connectionString nor host is provided", () => {
    expect(() => resolvePostgresPoolOptions({})).toThrowError(/connection/i);
  });
});
