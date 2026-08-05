// Connection-config helper for the Postgres adapter. Pure (no `pg`
// runtime dep) so unit tests don't need to spin up the driver. The
// adapter factory consumes the output and hands it to `new pg.Pool(...)`.

import { ConnectionError } from "../domain/errors";
import { hardenSslMode, type SslMode } from "../domain/ssl-mode";

// Re-exported so callers that already reach for the Postgres config do not
// need a second import for the mode it resolves to.
export type { SslMode };

const DEFAULT_STATEMENT_TIMEOUT_MS = 30_000;
const DEFAULT_POOL_SIZE = 4;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;

// How long the client timer waits past the server's own deadline. Sized to
// cover a cancellation round trip on a slow link — generous, because the
// cost of being too generous is a few seconds on a query that has already
// blown its budget, while the cost of being too tight is the user losing
// the server's explanation of what happened.
const CLIENT_TIMEOUT_GRACE_MS = 2_000;

export interface PostgresConnectionConfig {
  // Caller picks one path or the other. connectionString wins when both
  // are supplied (mirrors libpq behavior).
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  // Explicit TLS choice. Outranks anything the connectionString says: on
  // the split-fields path there is no URL to carry it, and on the URL path
  // a form control that lost to a stale query parameter would be
  // displaying a choice it does not make.
  sslMode?: SslMode;
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
  sslmode?: SslMode;
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
  //
  // The two budgets are deliberately NOT equal. The server's abort is the
  // one we want the user to see — it names the cause and carries SQLSTATE
  // 57014 — and it needs a round trip to arrive, while the client timer
  // needs none. Given the same deadline the client wins often enough to be
  // a coin toss, and the user gets a bare "Query read timeout" instead.
  // `query_timeout` is therefore the deadline plus one grace period: still
  // a backstop for a connection that has stopped answering, no longer a
  // competitor to the server's own timeout.
  query_timeout: number;
  statement_timeout: number;
}

// `hardenSslMode` lives in `domain/ssl-mode` — the rule is not a Postgres
// detail. What is Postgres-specific is why `prefer` needs rewriting rather
// than honouring: libpq reads it as "try TLS, fall back to plaintext", and
// node-pg does not implement the fallback at all, so this API resolved it
// to no-TLS outright. A URL carrying it was asking for the one behaviour
// ADR-0078 removes.

/**
 * `next`, with the password the connection is already using when `next`
 * does not state one of its own.
 *
 * The web counterpart of desktop's `dsn_with_stored_password` (ADR-0080
 * decision 3), and the reason an edit form is possible at all: the browser
 * is shown where a connection points but never the credential, so a save
 * that leaves the password box untouched has to be completed here. The graft
 * happens inside this process, on the way to a new pool. The credential is
 * not sent out so that it can be sent back.
 *
 * The only difference from desktop is where "already using" is read from.
 * Desktop asks the OS keyring; web has none, so the source is the config the
 * live adapter was built from — held privately by `PostgresAdapter`, which
 * calls this on its own behalf and returns a successor rather than a secret.
 *
 * **A blank password is an omitted one, never a removal** (ADR-0080's
 * consequence). A form that round-trips its inputs sends `""` for a box
 * nobody typed in, and reading that as "connect without a password" would
 * break every save that did not retype the credential. Dropping a password
 * for good is done by deleting the connection and adding it again — rare,
 * unambiguous, and impossible to trigger by accident.
 */
export function carryCredential(
  previous: PostgresConnectionConfig,
  next: PostgresConnectionConfig,
): PostgresConnectionConfig {
  if (statedCredential(next) !== undefined) return next;

  const carried = storedCredential(previous);
  if (carried === undefined) return next;

  // Written where the resolver will read it. With a connectionString
  // present `resolvePostgresPoolOptions` ignores the password field
  // entirely, so a credential parked there would be one nothing uses.
  if (next.connectionString === undefined) return { ...next, password: carried };

  const grafted = urlWithPassword(next.connectionString, carried);
  return grafted === undefined ? next : { ...next, connectionString: grafted };
}

// What `next` says about its own credential. Lenient about a malformed URL:
// that is the caller's fresh input, and reporting it here would blame the
// password carry for a DSN the user just mistyped. Left alone, it reaches
// `resolvePostgresPoolOptions`, which names it for what it is.
function statedCredential(config: PostgresConnectionConfig): string | undefined {
  if (config.connectionString === undefined) return blankToUndefined(config.password);
  try {
    return blankToUndefined(decodeURIComponent(new URL(config.connectionString).password));
  } catch {
    return undefined;
  }
}

// What the connection is using now. Strict, per ADR-0080 decision 3: a
// stored value that cannot be read is an error, not a fall-through to
// "there was no password" — that fall-through would quietly rebuild the
// pool without a credential and report the resulting refusal as an
// authentication problem at the far end.
//
// Precedence mirrors the resolver: with a connectionString present the
// password field is not consulted, because the live pool did not consult it
// either.
function storedCredential(previous: PostgresConnectionConfig): string | undefined {
  if (previous.connectionString === undefined) return blankToUndefined(previous.password);
  try {
    return blankToUndefined(decodeURIComponent(new URL(previous.connectionString).password));
  } catch {
    throw new ConnectionError(
      "the stored connection string for this connection cannot be read, so its password cannot be reused — re-enter the connection details",
    );
  }
}

function urlWithPassword(text: string, password: string): string | undefined {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  // The setter percent-encodes for us, which is the point of going through
  // `URL` rather than splicing strings: a password containing `@`, `/` or
  // `#` would otherwise re-parse as a different connection.
  url.password = password;
  return url.toString();
}

function blankToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

export function resolvePostgresPoolOptions(
  input: PostgresConnectionConfig,
): ResolvedPostgresPoolOptions {
  const statementTimeoutMs = input.statementTimeoutMs ?? DEFAULT_STATEMENT_TIMEOUT_MS;

  if (input.connectionString) {
    const url = new URL(input.connectionString);
    const sslmode = hardenSslMode(input.sslMode ?? url.searchParams.get("sslmode"));
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
      query_timeout: statementTimeoutMs + CLIENT_TIMEOUT_GRACE_MS,
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
    sslmode: hardenSslMode(input.sslMode),
    max: DEFAULT_POOL_SIZE,
    idleTimeoutMillis: DEFAULT_IDLE_TIMEOUT_MS,
    query_timeout: statementTimeoutMs + CLIENT_TIMEOUT_GRACE_MS,
    statement_timeout: statementTimeoutMs,
  };
}
