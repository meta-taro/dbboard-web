import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, ConnectionError, QueryError, SchemaError } from "../domain/errors";
import {
  NULL_CAPABILITIES,
  type Capabilities,
  type Column,
  type ColumnInfo,
  type QueryResult,
  type TableInfo,
  type TableSchema,
} from "../domain/values";
import type { Value } from "../domain/values/value";
import type { AdapterConfig } from "../usecase/adapter-factory.port";
import { sqliteJsonToValue } from "./libsql-value-mapping";

// Cloudflare D1, mirroring desktop `crates/dbboard-d1` at `b98f7a6`.
//
// D1 has no driver: Cloudflare exposes it to outside callers only through
// `POST /accounts/{account}/d1/database/{db}/raw`, and the Workers binding
// is Worker-only. So this adapter is an HTTP client that maps Cloudflare's
// JSON envelope onto the contract's types. `/raw` rather than `/query`
// because it preserves column order and returns rows as positional arrays,
// which is what the contract's rows are — and because it returns the same
// envelope for SELECT and DML, so no statement routing is needed.
//
// **`has_atomic_restore` is false and there is no `executeInTransaction`.**
// `/raw` takes one statement and has no multi-statement transaction, so a
// restore cannot be atomic here (desktop ADR-0051). This is the adapter
// `0030` slice D wrote its per-statement restore branch for; that branch
// stops being dead code with this file.
//
// Two things web needs that desktop does not, both because the values
// arrive in an HTTP request body rather than from the operator of the
// machine the process runs on:
//
// - **The endpoint is not configurable.** Desktop's `D1Config` carries a
//   `base_url` for tests and self-hosted gateways. Exposing one here would
//   let a caller aim an authenticated request at an address inside the
//   deployment's network; the transport seam covers the testing half of
//   what `base_url` was for.
// - **The ids are checked before they reach a URL.** They are path
//   segments, so `../..` in one would aim the request at a different
//   Cloudflare API with the account's own token attached.

const RAW_ENDPOINT_ROOT = "https://api.cloudflare.com/client/v4";

// `_cf_%` alongside SQLite's own `sqlite_%`: every D1 database carries at
// least `_cf_KV`, which `sqlite_master` lists and the Workers SQLite
// authorizer refuses to open — every read of it, PRAGMA included, comes
// back `[7500] not authorized: SQLITE_AUTH`. Desktop found this by watching
// it blank the whole structure view, whose relationship sweep PRAGMAs every
// listed table. `ESCAPE '\'` makes the underscores literal; unescaped,
// LIKE's `_` wildcard would also drop a user table named `acf_log`.
const LIST_TABLES_SQL =
  "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' " +
  "AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' ORDER BY name";

// Cap on response text surfaced in an error, so a hostile or malformed
// response cannot put an unbounded string in an HTTP error body.
const MAX_ERROR_DETAIL = 2048;

/** What the transport hands back: an HTTP status and the response text. */
export interface D1Response {
  status: number;
  body: string;
}

/**
 * The HTTP seam, narrow enough for a test to implement in three lines.
 *
 * The same shape `anthropic-provider.ts` uses for its client: the adapter
 * owns parsing, envelope checking and error classification, and only the
 * socket sits behind the interface. Handing back the raw text rather than a
 * parsed object is deliberate — a Cloudflare HTML 5xx page is a case the
 * adapter has to decide about, so it must be able to see one.
 */
export interface D1Transport {
  post(sql: string): Promise<D1Response>;
}

export class D1Adapter implements DatabaseAdapter {
  constructor(
    private readonly transport: D1Transport,
    // Kept only so it can be scrubbed from transport messages, the same
    // reason `TursoAdapter` keeps its token: a client that echoes the
    // request would otherwise put a bearer credential in an error body.
    private readonly secret?: string,
    // Kept so `rebuildWith` can carry the connection forward without the
    // factory needing an accessor for the credential (ADR-0080).
    private readonly config?: AdapterConfig,
  ) {}

  getId(): string {
    return "d1";
  }

  getCapabilities(): Capabilities {
    return {
      ...NULL_CAPABILITIES,
      has_describe_table: true,
      has_table_ddl: true,
      has_execute: true,
      // `has_atomic_restore` stays false, and there is no
      // `executeInTransaction` to go with it — see the header.
    };
  }

  async listTables(): Promise<TableInfo[]> {
    // Desktop's `reclassify_schema`: the caller did not write this SQL, so
    // reporting its failure as their query error points them at the wrong
    // thing. A connection failure stays one — it is not about the shape of
    // anything.
    const result = await this.introspect(LIST_TABLES_SQL);
    return result.rows.map((row) => {
      const name = row[0];
      if (typeof name !== "string") {
        throw new SchemaError(`expected a text table name, got ${describeCell(name)}`);
      }
      return { schema: null, name };
    });
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    return toQueryResult(await this.post(sql));
  }

  async describeTable(table: TableInfo): Promise<TableSchema> {
    // A PRAGMA argument cannot be bound as a parameter, so the name is
    // interpolated with single quotes doubled — SQLite string-literal
    // escaping. It usually comes from `listTables`, but it arrives over
    // HTTP and nothing stops a caller sending anything.
    const result = await this.query(`PRAGMA table_info('${escapeLiteral(table.name)}')`);

    if (result.rows.length === 0) {
      // PRAGMA returns zero rows for a table that is not there rather than
      // failing, so the adapter synthesises SQLite's own message shape.
      // Desktop ADR-0028: a missing table is a query error, not a 500.
      throw new QueryError(`no such table: ${table.name}`);
    }

    // By name rather than by position, as desktop does, so a reordered
    // envelope still maps correctly instead of silently reading `notnull`
    // where `pk` was meant.
    const at = columnLocator(result, "PRAGMA table_info");
    const cid = at("cid");
    const name = at("name");
    const declared = at("type");
    const notnull = at("notnull");
    const dflt = at("dflt_value");
    const pk = at("pk");

    // (position within the key, column name) — PRAGMA emits these in column
    // order, not key order, so they are sorted below.
    const keyParts: [number, string][] = [];
    const columns = result.rows.map((row): ColumnInfo => {
      const columnName = text(row[name], "name");
      const position = integer(row[pk], "pk");
      if (position > 0) keyParts.push([position, columnName]);

      const declaredType = text(row[declared], "type");
      return {
        name: columnName,
        // A typeless SQLite column reports an empty string.
        declared_type: declaredType === "" ? null : declaredType,
        nullable: integer(row[notnull], "notnull") === 0,
        primary_key: position > 0,
        // `cid` counts from zero; the contract's `ordinal` counts from one.
        ordinal: integer(row[cid], "cid") + 1,
        default_value: row[dflt] === null ? null : String(row[dflt]),
      };
    });

    keyParts.sort((a, b) => a[0] - b[0]);
    return { table, columns, primary_key: keyParts.map(([, columnName]) => columnName) };
  }

  async tableDdl(table: TableInfo): Promise<string> {
    // SQLite keeps each object's own `CREATE` text verbatim in
    // `sqlite_master.sql`, so a table's DDL plus every index it owns comes
    // back in one round trip (desktop ADR-0049 Decision 4). Auto-created
    // indexes — those backing PRIMARY KEY / UNIQUE — carry a NULL `sql` and
    // are filtered in SQL: the table DDL recreates them implicitly, and
    // emitting them would produce `CREATE null;`.
    const escaped = escapeLiteral(table.name);
    const result = await this.query(
      "SELECT type, sql FROM sqlite_master " +
        `WHERE (type = 'table' AND name = '${escaped}') ` +
        `OR (type = 'index' AND tbl_name = '${escaped}' AND sql IS NOT NULL) ` +
        "ORDER BY (type = 'table') DESC, name",
    );

    const at = columnLocator(result, "sqlite_master");
    const kindAt = at("type");
    const sqlAt = at("sql");

    let createTable: string | null = null;
    const indexes: string[] = [];
    for (const row of result.rows) {
      const kind = row[kindAt];
      const statement = row[sqlAt];
      if (typeof kind !== "string" || typeof statement !== "string") {
        // Not something `sqlite_master` emits, so the envelope is wrong
        // rather than the request — dropping the row silently would produce
        // a dump missing an index nobody asked about.
        throw new SchemaError(`unexpected sqlite_master row for ${table.name}`);
      }
      if (kind === "table") createTable = statement;
      else if (kind === "index") indexes.push(statement);
    }

    if (createTable === null) {
      // Orphan index rows land here too. They are not reachable from
      // SQLite, which drops a table's indexes with it, and emitting them
      // alone would produce a dump that cannot restore.
      throw new QueryError(`no such table: ${table.name}`);
    }

    // `sqlite_master.sql` stores each statement without its semicolon.
    return [createTable, ...indexes].map((s) => `${s.trimEnd()};\n`).join("");
  }

  async execute(sql: string): Promise<number> {
    // `/raw` returns the same envelope for DML and DDL and reports the
    // affected count in `meta.changes`. A write has no rows worth reading,
    // so the payload is discarded.
    return (await this.executeQuery(sql)).rows_affected;
  }

  /**
   * A replacement pointed at `config`, keeping this adapter's API token
   * when the edit does not supply one (0027 slice G, desktop ADR-0080).
   *
   * On the adapter rather than in the factory for the reason
   * `TursoAdapter.rebuildWith` is: the factory has no accessor for the
   * credential and should not grow one. Raises before anything is torn
   * down, so a rejected edit leaves the connection it was editing intact.
   */
  rebuildWith(config: AdapterConfig): D1Adapter {
    // Blank counts as unsaid, not as "clear it": an edit form never
    // prefills a credential box, so it round-trips `""` for the one nobody
    // typed in. Taking that literally would swap a working token for an
    // empty bearer header and report the 401 as the user's.
    const stated =
      config.authToken === undefined || config.authToken === "" ? undefined : config.authToken;
    return createD1Adapter(
      stated === undefined ? { ...config, authToken: this.config?.authToken } : config,
    );
  }

  /** A query whose failure is about the schema, not the caller's SQL. */
  private async introspect(sql: string): Promise<QueryResult> {
    try {
      return await this.query(sql);
    } catch (e) {
      // Desktop's `reclassify_schema`, which leaves `Connection` alone: a
      // dead server is not a malformed schema.
      if (e instanceof QueryError) throw new SchemaError(e.message);
      throw e;
    }
  }

  private async query(sql: string): Promise<QueryResult> {
    return toQueryResult(await this.post(sql));
  }

  /** POST one statement and return the parsed, success-checked envelope. */
  private async post(sql: string): Promise<D1Envelope> {
    let response: D1Response;
    try {
      response = await this.transport.post(sql);
    } catch (e) {
      throw new ConnectionError(this.redact(truncate(messageOf(e))));
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      // A divergence from desktop, which calls this `Query`. The likeliest
      // way to get here is a Cloudflare HTML 5xx page, and the house rule
      // (`turso-adapter.ts`) is that a 502 which turns out to be a bad
      // query misleads far less than a 400 which turns out to be a dead
      // server.
      throw new ConnectionError(
        `malformed D1 response (status ${response.status}): ${truncate(this.redact(response.body))}`,
      );
    }

    const envelope = parsed as D1Envelope;
    if (envelope?.success === true) return envelope;
    throw errorFromResponse(response.status, envelope?.errors);
  }

  private redact(message: string): string {
    if (!this.secret) return message;
    return message.split(this.secret).join("***");
  }
}

// Cloudflare's standard API envelope, narrowed to the fields used here.
interface D1Envelope {
  success?: boolean;
  result?: D1StatementResult[];
  errors?: D1ApiError[];
}

interface D1ApiError {
  code?: number;
  message?: string;
}

interface D1StatementResult {
  results?: { columns?: string[]; rows?: unknown[][] };
  meta?: { changes?: number };
}

/**
 * The first statement result as a `QueryResult`.
 *
 * `declared_type` is always null: `/raw` reports no per-column type, and
 * desktop sets `None` for the same reason. Guessing from the first row's
 * storage class would label an all-NULL column wrongly.
 *
 * **No row cap here**, unlike desktop. `ROW_CAP` lives in `domain/limits.ts`
 * and ExecuteQuery applies it after the adapter returns, "so no adapter can
 * forget"; checking again here would cap twice and report a second, unequal
 * error for the same condition.
 */
function toQueryResult(envelope: D1Envelope): QueryResult {
  const first = envelope.result?.[0];
  if (!first) throw new QueryError("D1 returned no statement result");

  const columns: Column[] = (first.results?.columns ?? []).map((name) => ({
    name,
    declared_type: null,
  }));

  return {
    columns,
    rows: (first.results?.rows ?? []).map((row) => row.map(sqliteJsonToValue)),
    rows_affected: first.meta?.changes ?? 0,
  };
}

/**
 * Classify an API failure by HTTP status, as desktop does:
 *
 * - 401/403 — authentication, so the connection rather than the query.
 * - 429 and 5xx — rate limit or outage; transient infrastructure, again not
 *   a problem with the SQL.
 * - anything else — the caller's query (a SQL error arrives as HTTP 400).
 *
 * Cloudflare's messages are safe to surface: the token is never echoed.
 */
function errorFromResponse(status: number, errors: D1ApiError[] | undefined): Error {
  const detail = joinErrors(errors);
  if (status === 401 || status === 403) {
    return new ConnectionError(`authentication failed: ${detail}`);
  }
  if (status === 429 || (status >= 500 && status <= 599)) {
    return new ConnectionError(`D1 unavailable (status ${status}): ${detail}`);
  }
  return new QueryError(detail);
}

function joinErrors(errors: D1ApiError[] | undefined): string {
  if (!errors || errors.length === 0) return "D1 request failed without an error message";
  return truncate(
    errors
      .map((e) => (e.code === undefined ? (e.message ?? "") : `[${e.code}] ${e.message ?? ""}`))
      .join("; "),
  );
}

function truncate(text: string): string {
  return text.length <= MAX_ERROR_DETAIL ? text : `${text.slice(0, MAX_ERROR_DETAIL)}…`;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function escapeLiteral(name: string): string {
  return name.replace(/'/g, "''");
}

/** Locate a result column by name, or say which one the envelope lacks. */
function columnLocator(result: QueryResult, source: string): (field: string) => number {
  return (field: string): number => {
    const at = result.columns.findIndex((c) => c.name === field);
    if (at < 0) throw new SchemaError(`${source} result is missing the '${field}' column`);
    return at;
  };
}

function integer(cell: Value | undefined, field: string): number {
  if (typeof cell !== "number") {
    throw new SchemaError(`expected an integer '${field}', got ${describeCell(cell)}`);
  }
  return cell;
}

function text(cell: Value | undefined, field: string): string {
  if (typeof cell !== "string") {
    throw new SchemaError(`expected a text '${field}', got ${describeCell(cell)}`);
  }
  return cell;
}

// The cell's shape, never its content: a PRAGMA row is schema, but a
// mis-shaped row from an arbitrary query is user data.
function describeCell(cell: Value | undefined): string {
  if (cell === undefined) return "nothing";
  if (cell === null) return "null";
  return typeof cell;
}

// D1's ids are path segments in an authenticated URL. Cloudflare's own are
// 32-character hex, but rather than pin a format the server has no contract
// for, this refuses only what could change which endpoint is addressed.
const PATH_SAFE = /^[A-Za-z0-9_-]+$/;

/**
 * Production factory. No network I/O — the first statement opens the
 * connection — so calling this at registration time costs nothing.
 *
 * The endpoint is fixed rather than configurable. Desktop's `base_url`
 * exists for tests and self-hosted gateways; here the config arrives in an
 * HTTP request body, where it would let a caller point an adapter carrying
 * the deployment's credentials at an internal address. Tests reach the
 * adapter by constructing `new D1Adapter(transport)` directly, the same
 * split `createTursoAdapter` / `new TursoAdapter(client)` already has.
 */
export function createD1Adapter(config: AdapterConfig): D1Adapter {
  const accountId = config.accountId?.trim();
  const databaseId = config.databaseId?.trim();
  const token = config.authToken?.trim();

  // CapabilityError, not a 500: the request named a driver this server has,
  // configured in a way it cannot serve. Surfaces as 404, matching
  // `createTursoAdapter` and `createPostgresAdapter`.
  if (!accountId) throw new CapabilityError("d1 driver requires accountId");
  if (!databaseId) throw new CapabilityError("d1 driver requires databaseId");
  // Fail fast rather than sending `Bearer ` and waiting for a 401 that
  // reads like a wrong credential instead of a missing one.
  if (!token) throw new CapabilityError("d1 driver requires authToken (a Cloudflare API token)");

  if (!PATH_SAFE.test(accountId) || !PATH_SAFE.test(databaseId)) {
    throw new CapabilityError(
      "d1 accountId and databaseId may contain only letters, digits, '-' and '_'",
    );
  }

  const url = `${RAW_ENDPOINT_ROOT}/accounts/${accountId}/d1/database/${databaseId}/raw`;
  return new D1Adapter(new FetchTransport(url, token), token, {
    ...config,
    accountId,
    databaseId,
    authToken: token,
  });
}

/** The only part of the adapter that touches the network. */
class FetchTransport implements D1Transport {
  constructor(
    private readonly url: string,
    private readonly token: string,
  ) {}

  async post(sql: string): Promise<D1Response> {
    const response = await fetch(this.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ sql, params: [] }),
    });
    return { status: response.status, body: await response.text() };
  }
}
