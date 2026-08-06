import { createClient, type Client, type ResultSet, type Row } from "@libsql/client";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, ConnectionError, QueryError } from "../domain/errors";
import {
  NULL_CAPABILITIES,
  type Capabilities,
  type Column,
  type ColumnInfo,
  type QueryResult,
  type TableInfo,
  type TableSchema,
} from "../domain/values";
import type { AdapterConfig } from "../usecase/adapter-factory.port";
import { libsqlColumnType, libsqlValueToValue } from "./libsql-value-mapping";

// Turso / libSQL, mirroring desktop `crates/dbboard-turso` at `b98f7a6`.
//
// Two things desktop does are deliberately not mirrored, because the JS
// driver does not have the constraints the Rust one does:
//
// - **No `is_row_returning` router.** libSQL's Rust driver splits
//   row-returning and DML across two entry points and rejects a statement
//   sent through the wrong one, so desktop classifies by first keyword.
//   `@libsql/client`'s `execute` takes both and reports `rowsAffected`
//   either way, so the classifier would only be an opportunity to get the
//   keyword list wrong. `executeQuery` pins that this holds.
// - **No hand-rolled BEGIN/COMMIT/ROLLBACK.** `batch(…, "write")` runs the
//   statements in one implicit transaction and rolls back itself. Desktop's
//   best-effort `ROLLBACK` exists because it is driving the transaction by
//   hand; here the driver owns it, so there is no window where a failed
//   rollback leaves the session mid-transaction.
//
// What is mirrored exactly is everything the *engine* decides: the
// `sqlite_%` filter, the PRAGMA quote-doubling, the 1-based ordinal, the
// composite-key ordering, and the synthesised `no such table` message.

const LIST_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name";

// libSQL reports engine-level failures with a `SQLITE_`-prefixed code — the
// statement reached SQLite and SQLite refused it, which is the caller's
// fault (400). Everything else is the transport: CLIENT_CLOSED, the HRANA_*
// protocol codes, SERVER_ERROR, a fetch that never landed. Codeless errors
// join them, on the same reasoning `isConnectionLevelError` uses for pg —
// a 502 that turns out to be a bad query misleads far less than a 400 that
// turns out to be a dead server.
function isEngineLevelError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("SQLITE_");
}

// Remote-only, and this is a security boundary rather than a preference.
// See `createTursoAdapter`.
const REMOTE_SCHEMES = new Set(["libsql:", "https:", "http:", "wss:", "ws:"]);

function schemeOf(url: string): string | null {
  // RFC 3986 scheme grammar. `:memory:` fails it (a scheme cannot start
  // with `:`), and a bare path has no colon at all — both land as null.
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(url);
  return match ? `${match[1].toLowerCase()}:` : null;
}

export class TursoAdapter implements DatabaseAdapter {
  constructor(
    private readonly client: Client,
    // The auth token, kept only so it can be scrubbed out of driver error
    // messages. Desktop redacts the database path for the same reason
    // (`redact_path`); here the path is never secret — the token is, and a
    // driver that echoes the request URL would put it in an HTTP error body.
    private readonly secret?: string,
  ) {}

  getId(): string {
    return "turso";
  }

  getCapabilities(): Capabilities {
    return {
      ...NULL_CAPABILITIES,
      has_describe_table: true,
      has_execute: true,
      has_atomic_restore: true,
      // `has_table_ddl` stays false, and there is no `tableDdl` method to
      // go with it: desktop's crate has no `table_ddl` either. SQLite does
      // keep the original DDL text in `sqlite_master.sql`, so this is a
      // gap that could be closed — but closing it here, ahead of desktop,
      // would make web's capabilities stop being a mirror of a shipped
      // adapter and start being an opinion.
    };
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.run(LIST_TABLES_SQL);
    return result.rows.map((row) => ({ schema: null, name: String(row["name"]) }));
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const result = await this.run(sql);
    return {
      columns: columnsOf(result),
      // Array-*like*, not an array: `Row` carries both numeric and named
      // keys, and `Array.isArray` says false. `Array.from` reads it through
      // `length`, which drops the named half — the contract's rows are
      // positional.
      rows: result.rows.map((row) => Array.from(row as ArrayLike<unknown>).map(libsqlValueToValue)),
      rows_affected: result.rowsAffected,
    };
  }

  async describeTable(table: TableInfo): Promise<TableSchema> {
    // A PRAGMA argument cannot be bound as a parameter, so the name is
    // interpolated with single quotes doubled — SQLite string-literal
    // escaping. The name usually comes from `listTables`, but it arrives
    // over HTTP and nothing stops a caller sending anything.
    const escaped = table.name.replace(/'/g, "''");
    const result = await this.run(`PRAGMA table_info('${escaped}')`);

    // (position within the key, column name) — PRAGMA emits these in
    // column order, not key order, so they are sorted below.
    const keyParts: [number, string][] = [];
    const columns = result.rows.map((row) => columnFromPragmaRow(row, keyParts));

    if (columns.length === 0) {
      // PRAGMA returns zero rows for a table that is not there rather than
      // failing, so the adapter synthesises SQLite's own message shape.
      // Desktop ADR-0028: a missing table is a query error, not a 500.
      throw new QueryError(`no such table: ${table.name}`);
    }

    keyParts.sort((a, b) => a[0] - b[0]);
    return { table, columns, primary_key: keyParts.map(([, name]) => name) };
  }

  async execute(sql: string): Promise<number> {
    return (await this.run(sql)).rowsAffected;
  }

  async executeInTransaction(statements: readonly string[]): Promise<void> {
    // An empty batch is a no-op. The driver would accept it, but on a
    // remote database it is a round trip that can only succeed at doing
    // nothing.
    if (statements.length === 0) return;

    try {
      await this.client.batch([...statements], "write");
    } catch (e) {
      throw this.translateError(e);
    }
  }

  async close(): Promise<void> {
    this.client.close();
  }

  /**
   * A replacement pointed at `config`, keeping this adapter's auth token
   * when the edit does not supply one (0027 slice G, desktop ADR-0080).
   *
   * On the adapter rather than in the factory for the reason
   * `PostgresAdapter.rebuildWith` is: the factory has no accessor for the
   * credential and should not grow one. The token moves from one private
   * field to the next without ever being returned.
   *
   * Raises before anything is torn down, so a rejected edit leaves the
   * connection it was editing intact.
   */
  rebuildWith(config: AdapterConfig): TursoAdapter {
    // Blank counts as unsaid, not as "clear it" — the same reading
    // `carryCredential` gives a blank password, and for the same reason: an
    // edit form never prefills a credential box, so it round-trips `""` for
    // the one nobody typed in. Taking that literally would swap a working
    // token for an empty bearer header and report the 401 as the user's.
    const stated =
      config.authToken === undefined || config.authToken === "" ? undefined : config.authToken;
    return createTursoAdapter(
      stated === undefined ? { ...config, authToken: this.secret } : config,
    );
  }

  private async run(sql: string): Promise<ResultSet> {
    try {
      return await this.client.execute(sql);
    } catch (e) {
      throw this.translateError(e);
    }
  }

  private translateError(e: unknown): Error {
    if (e instanceof QueryError || e instanceof ConnectionError) return e;
    const message = this.redact(e instanceof Error ? e.message : String(e));
    return isEngineLevelError(e) ? new QueryError(message) : new ConnectionError(message);
  }

  private redact(message: string): string {
    if (!this.secret) return message;
    return message.split(this.secret).join("***");
  }
}

function columnsOf(result: ResultSet): Column[] {
  return result.columns.map((name, i) => ({
    name,
    declared_type: libsqlColumnType(result.columnTypes[i]),
  }));
}

function columnFromPragmaRow(row: Row, keyParts: [number, string][]): ColumnInfo {
  // PRAGMA table_info: (cid, name, type, notnull, dflt_value, pk).
  const name = String(row["name"]);
  const position = numeric(row["pk"]);
  if (position > 0) keyParts.push([position, name]);

  return {
    name,
    declared_type: libsqlColumnType(row["type"] === null ? null : String(row["type"])),
    nullable: numeric(row["notnull"]) === 0,
    primary_key: position > 0,
    // `cid` counts from zero; the contract's `ordinal` counts from one.
    ordinal: numeric(row["cid"]) + 1,
    default_value: row["dflt_value"] === null ? null : String(row["dflt_value"]),
  };
}

// PRAGMA's integer columns arrive as bigint because the client is opened
// with `intMode: "bigint"`. They are all small by construction — a column
// index, a flag, a key position — so narrowing is unconditional here,
// unlike in the value mapping where the magnitude is the user's.
function numeric(raw: unknown): number {
  return typeof raw === "bigint" ? Number(raw) : Number(raw ?? 0);
}

/**
 * Production factory. `createClient` is lazy for the remote transports — no
 * socket opens until the first statement — so calling this at registration
 * time costs nothing.
 *
 * **Remote schemes only, and that is a boundary rather than a preference.**
 * Desktop takes this string from the operator of the machine it runs on, so
 * `connect_local(":memory:")` and a file path are ordinary. Web takes it
 * from an HTTP request body: a `file:` URL would let any caller open any
 * SQLite file the API process can read, and hand back its contents through
 * `GET /tables`. Tests reach the local engine by constructing
 * `new TursoAdapter(client)` directly, the same split
 * `createPostgresAdapter` and `new PostgresAdapter(pool)` already have.
 */
export function createTursoAdapter(config: AdapterConfig): TursoAdapter {
  const url = config.connectionString?.trim();
  if (!url) {
    // CapabilityError, not a 500: the request named a driver this server
    // has, configured in a way it cannot serve. Surfaces as 404, matching
    // `createPostgresAdapter`.
    throw new CapabilityError("turso driver requires connectionString (a libsql:// URL)");
  }

  const scheme = schemeOf(url);
  if (scheme === null || !REMOTE_SCHEMES.has(scheme)) {
    throw new CapabilityError(
      "turso driver accepts only remote URLs (libsql://, https://, http://, wss://, ws://)",
    );
  }

  return new TursoAdapter(
    createClient({
      url,
      authToken: config.authToken,
      // Without this the driver narrows a 64-bit INTEGER to a JS number and
      // loses precision before the adapter can see it. The narrowing
      // decision belongs to `libsqlValueToValue`, which can report the
      // digits as text instead.
      intMode: "bigint",
    }),
    config.authToken,
  );
}
