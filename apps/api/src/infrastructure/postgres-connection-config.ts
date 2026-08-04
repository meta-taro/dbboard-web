// Connection-config helper for the Postgres adapter. Pure (no `pg`
// runtime dep) so unit tests don't need to spin up the driver. The
// adapter factory consumes the output and hands it to `new pg.Pool(...)`.

// Hostnames whose pooled flavours we know reject anything but TLS. We
// silently upgrade sslmode for these so the user doesn't have to remember
// the per-vendor quirk — desktop counterpart has the same list.
const SSL_REQUIRED_HOST_SUFFIXES = [".neon.tech", ".supabase.co"];

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_SIZE = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

export interface PostgresConnectionConfig {
  // Caller picks one path or the other. connectionString wins when both
  // are supplied (mirrors libpq behavior).
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  // Per-connection override; defaults to 30 s per the ticket.
  statementTimeoutMs?: number;
}

// Mirrors the slice of `pg.PoolConfig` we need. We deliberately do not
// import the type from `pg` here so the connection-config layer stays
// driver-agnostic and pure-data.
export interface ResolvedPostgresPoolOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  sslmode?: "prefer" | "require" | "disable";
  max: number;
  idleTimeoutMillis: number;
  // Two timeouts, same budget, different failure sites — keep both.
  //
  // `query_timeout` is a client-side setTimeout inside pg
  // (pg@8.21.0 lib/client.js:654). It stops the caller waiting; it sends
  // nothing to the server, issues no CancelRequest, and does not destroy
  // the socket. On its own it produces a specific correctness bug: the
  // caller is told the statement failed while it is still running and —
  // outside an explicit transaction — the write still commits.
  //
  // `statement_timeout` goes into the startup packet (lib/client.js:543,
  // `getStartupConf`), so the *server* aborts the statement with SQLSTATE
  // 57014. Set once at connect: no per-query `SET`, no extra round trip.
  //
  // Postgres reads a bare integer as milliseconds. Mirrors desktop
  // ADR-0081, minus the MySQL/MariaDB variable probe — desktop states the
  // Postgres name and unit have no such divergence, so there is nothing to
  // probe. See .claude/issues/0024-adapter-correctness.md.
  query_timeout: number;
  statement_timeout: number;
}

function hostNeedsSsl(host: string | null | undefined): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  return SSL_REQUIRED_HOST_SUFFIXES.some((s) => lower.endsWith(s));
}

export function resolvePostgresPoolOptions(
  input: PostgresConnectionConfig,
): ResolvedPostgresPoolOptions {
  const statementTimeoutMs = input.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

  if (input.connectionString) {
    const url = new URL(input.connectionString);
    const forceRequire = hostNeedsSsl(url.hostname);
    let sslmode: "prefer" | "require" | "disable" = "prefer";
    if (forceRequire) {
      sslmode = "require";
    } else {
      const supplied = url.searchParams.get("sslmode");
      if (supplied === "require" || supplied === "disable" || supplied === "prefer") {
        sslmode = supplied;
      }
    }
    // Strip sslmode from the URL so the explicit `ssl` field on PoolConfig
    // is the single source of truth. pg-connection-string maps sslmode in
    // the URL to ssl: {} (require) and `ssl: false` from PoolConfig does
    // NOT reliably override the URL-derived value — easier to delete it.
    url.searchParams.delete("sslmode");
    return {
      connectionString: url.toString(),
      sslmode,
      max: DEFAULT_POOL_SIZE,
      idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
      query_timeout: statementTimeoutMs,
      statement_timeout: statementTimeoutMs,
    };
  }

  if (!input.host) {
    throw new Error(
      "postgres connection requires either a connectionString or host (+ database/user)",
    );
  }

  return {
    host: input.host,
    port: input.port,
    database: input.database,
    user: input.user,
    password: input.password,
    sslmode: hostNeedsSsl(input.host) ? "require" : "prefer",
    max: DEFAULT_POOL_SIZE,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    query_timeout: statementTimeoutMs,
    statement_timeout: statementTimeoutMs,
  };
}
