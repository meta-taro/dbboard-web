import { Logger } from "@nestjs/common";
import { Pool, type PoolConfig } from "pg";
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
import {
  carryCredential,
  resolvePostgresPoolOptions,
  type PostgresConnectionConfig,
} from "./postgres-connection-config";
import { pgOidToName, pgOidToValue } from "./postgres-type-mapping";

// The narrow `pg.Pool` slice we depend on. Defining it here (instead of
// importing pg.Pool directly into the adapter signature) keeps unit tests
// stub-friendly — they construct an object with just `query` + `end`,
// no native connection involved. Real `pg.Pool` satisfies this
// structurally.
export interface PgQueryRunner {
  // `values` binds parameters, which moves pg onto the extended protocol.
  // That is safe for the result decoding: pg requests text results unless
  // `binary: true` is set (pg-protocol's `bind` writes the result-format
  // code from that flag, and pg/lib/query.js leaves it unset), so
  // `assertTextWireFormat` is not in conflict with binding. Only
  // introspection uses it — user SQL still goes out unparameterised.
  query(config: { text: string; rowMode?: "array"; values?: unknown[] }): Promise<{
    rows: unknown[];
    // `format` is `'text' | 'binary'` on the real wire path
    // (pg-protocol parser.js:216 — `int16() === 0 ? 'text' : 'binary'`),
    // but optional here: pg's own result.js defaults it (`desc.format ||
    // 'text'`) and stubs in the specs omit it. Widened to `string` so an
    // unexpected value from a future pg is still comparable rather than a
    // type error.
    fields: { name: string; dataTypeID: number; format?: string }[];
    rowCount: number | null;
  }>;
  end(): Promise<void>;
}

const LIST_TABLES_SQL = `
  SELECT schemaname AS schema, tablename AS name
  FROM pg_catalog.pg_tables
  WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
  ORDER BY schemaname, tablename
`;

// Columns of one table in ordinal order (desktop ADR-0028). Every text
// column is cast to TEXT so the information_schema domain types
// (sql_identifier, character_data) come back as plain strings rather than
// as their domain OIDs, which `pgOidToName` would not recognise. The
// schema and table names are bound, never interpolated: they arrive from
// the client and reach a catalog view that has no quoting of its own.
const DESCRIBE_COLUMNS_SQL = `
  SELECT column_name::TEXT AS column_name,
         data_type::TEXT AS data_type,
         is_nullable::TEXT AS is_nullable,
         column_default::TEXT AS column_default,
         ordinal_position::INT4 AS ordinal_position
  FROM information_schema.columns
  WHERE table_schema = $1 AND table_name = $2
  ORDER BY ordinal_position
`;

// Primary-key column names of one table in key order (desktop ADR-0028).
// The join carries table_schema/table_name as well as the constraint name
// because a constraint name is unique only within its schema.
const DESCRIBE_PK_SQL = `
  SELECT kcu.column_name::TEXT AS column_name
  FROM information_schema.table_constraints tc
  JOIN information_schema.key_column_usage kcu
    ON kcu.constraint_name = tc.constraint_name
   AND kcu.constraint_schema = tc.constraint_schema
   AND kcu.table_schema = tc.table_schema
   AND kcu.table_name = tc.table_name
  WHERE tc.constraint_type = 'PRIMARY KEY'
    AND tc.table_schema = $1 AND tc.table_name = $2
  ORDER BY kcu.ordinal_position
`;

// Node-style errno codes for network-level failures. pg surfaces these
// verbatim when the underlying socket can't be established or the server
// goes away mid-query.
const NETWORK_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
]);

// Desktop ADR-0070. `pgOidToValue` decodes text-format bytes. Handed
// binary ones it does not fail loudly — a binary int4 of 1 is
// `00 00 00 01`, which passes a UTF-8 check and renders as four invisible
// control characters. Desktop shipped exactly that in v0.4.0.
//
// Web reaches the text path by omitting `values` from `pool.query`, which
// keeps pg on the simple protocol, plus a `getTypeParser` override. Both
// are conventions, not guarantees: adding a `values` array — the obvious
// shape of a future parameterisation change — flips the protocol with no
// other visible symptom. So the invariant is checked against what the
// server actually replied, not against our own call site, and it is
// checked at runtime. Desktop ADR-0070 Decision 4 is explicit that a
// silent corruption must not survive a release build because an assertion
// was compiled out.
//
// The trigger is `=== "binary"`, never `!== "text"`: the property is
// absent from every hand-built stub and pg defaults it downstream, so
// absence is not evidence. See .claude/issues/0024-adapter-correctness.md
// § invariant 1.
function assertTextWireFormat(fields: { name: string; format?: string }[]): void {
  const binary = fields.find((f) => f.format === "binary");
  if (binary) {
    throw new QueryError(
      `column "${binary.name}" came back in binary wire format; ` +
        `this adapter decodes text format only (see ADR-0070)`,
    );
  }
}

// One row of DESCRIBE_COLUMNS_SQL. Every field is text because the pool's
// `getTypeParser` override returns raw strings for every OID — including
// the INT4 ordinal, which is why it is parsed rather than used directly.
interface DescribeColumnRow {
  column_name: string;
  data_type: string;
  is_nullable: string | null;
  column_default: string | null;
  ordinal_position: string | number | null;
}

// `ordinal_position` is 1-based by the SQL standard. Anything else means a
// catalog we do not understand, and sorting the UI by a silent NaN is
// worse than refusing (desktop ADR-0028 Decision 3).
function parseOrdinal(raw: unknown, columnName: string): number {
  const ordinal = Number(raw);
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new QueryError(
      `non-positive ordinal_position ${JSON.stringify(raw)} for column ${columnName}`,
    );
  }
  return ordinal;
}

function columnFromRow(row: DescribeColumnRow, primaryKey: string[]): ColumnInfo {
  return {
    name: row.column_name,
    declared_type: row.data_type,
    // The SQL-standard spelling is "YES"/"NO"; compared case-insensitively
    // because not every engine agrees on the case.
    nullable: (row.is_nullable ?? "").toUpperCase() === "YES",
    primary_key: primaryKey.includes(row.column_name),
    ordinal: parseOrdinal(row.ordinal_position, row.column_name),
    default_value: row.column_default,
  };
}

function isConnectionLevelError(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const code = (e as { code?: unknown }).code;
  if (typeof code !== "string") {
    // No code at all — pg's pool surfaces some setup failures as plain
    // Error. Conservatively treat as connection-level so the caller sees
    // 502 instead of a misleading 400.
    return true;
  }
  if (NETWORK_ERROR_CODES.has(code)) return true;
  // SQLSTATE class "08" is "connection exception" per the SQL standard.
  if (code.startsWith("08")) return true;
  return false;
}

export class PostgresAdapter implements DatabaseAdapter {
  constructor(
    private readonly pool: PgQueryRunner,
    // The configuration this pool was built from, kept so the connection can
    // be re-pointed without asking the user to retype the password (0027
    // slice G). Optional because the tests inject a bare pool, and because a
    // successor is only ever needed for adapters `createPostgresAdapter`
    // made.
    //
    // No new exposure: the credential is already inside `pool`, and this
    // field is as private. What it buys is a way to hand it forward — see
    // `rebuildWith`, which is the only reader.
    private readonly config?: PostgresConnectionConfig,
  ) {}

  /**
   * A replacement adapter pointed at `next`, still authenticating as this
   * one does when `next` names no password of its own.
   *
   * Web's answer to desktop's keyring lookup (ADR-0080 decision 3), and it
   * lands in the same place: "the password is grafted back on inside the
   * Rust process — it never crosses into the webview in either direction."
   * Here the process is the API and the far side is the browser, but the
   * property is the one that matters — an edit form can move a connection to
   * a new host without the credential making a round trip to be sent back.
   *
   * A method rather than a `credential()` getter because of what it returns:
   * an adapter. The secret goes from one private field to another and there
   * is nothing to call that yields it. The caller still owns closing the
   * adapter it replaced — this one does not, since a failed rebuild should
   * leave the working connection working.
   */
  rebuildWith(next: PostgresConnectionConfig): PostgresAdapter {
    return createPostgresAdapter(carryCredential(this.config ?? {}, next));
  }

  getId(): string {
    return "postgres";
  }

  getCapabilities(): Capabilities {
    // Set alongside the method that implements it, per the port's contract:
    // the flag and `describeTable` travel together.
    return { ...NULL_CAPABILITIES, has_describe_table: true };
  }

  async listTables(): Promise<TableInfo[]> {
    try {
      const result = await this.pool.query({ text: LIST_TABLES_SQL });
      return (result.rows as Array<{ schema: string; name: string }>).map(({ schema, name }) => ({
        schema,
        name,
      }));
    } catch (e) {
      throw this.translateError(e);
    }
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    try {
      const result = await this.pool.query({ text: sql, rowMode: "array" });
      assertTextWireFormat(result.fields);
      const columns: Column[] = result.fields.map((f) => ({
        name: f.name,
        declared_type: pgOidToName(f.dataTypeID),
      }));
      const rows = (result.rows as unknown[][]).map((row) =>
        row.map((cell, i) => {
          const field = result.fields[i];
          return field ? pgOidToValue(field.dataTypeID, cell) : null;
        }),
      );
      return { columns, rows, rows_affected: result.rowCount ?? 0 };
    } catch (e) {
      throw this.translateError(e);
    }
  }

  async describeTable(table: TableInfo): Promise<TableSchema> {
    // An unqualified TableInfo means `public` — where unqualified DDL
    // lands on Postgres. Resolving it here rather than in SQL keeps the
    // bound value visible to the caller and to the tests.
    const schema = table.schema ?? "public";
    try {
      const columnResult = await this.pool.query({
        text: DESCRIBE_COLUMNS_SQL,
        values: [schema, table.name],
      });
      // Binding parameters moves this onto the extended protocol, where a
      // binary result format is at least expressible. The catalog values
      // are decoded as text like everything else, so hold the same
      // invariant here rather than assume the protocol switch is benign.
      assertTextWireFormat(columnResult.fields);
      const columnRows = columnResult.rows as DescribeColumnRow[];
      // information_schema answers an unknown table with an empty set
      // rather than an error. A table with no columns cannot be told apart
      // from a missing one, so report the missing one.
      if (columnRows.length === 0) {
        throw new QueryError(`relation "${schema}.${table.name}" does not exist`);
      }

      const pkResult = await this.pool.query({
        text: DESCRIBE_PK_SQL,
        values: [schema, table.name],
      });
      assertTextWireFormat(pkResult.fields);
      // Key order, not column order — it differs for composite keys and is
      // unrecoverable once lost.
      const primary_key = (pkResult.rows as Array<{ column_name: string }>).map(
        (r) => r.column_name,
      );

      return {
        table,
        columns: columnRows.map((row) => columnFromRow(row, primary_key)),
        primary_key,
      };
    } catch (e) {
      throw this.translateError(e);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private translateError(e: unknown): Error {
    // Our own domain errors pass through untouched. Without this the
    // wire-format guard, which throws from inside the same try block,
    // would be re-classified: it carries no `code`, and a codeless error
    // is deliberately read as connection-level below.
    if (e instanceof QueryError || e instanceof ConnectionError) return e;
    const message = e instanceof Error ? e.message : String(e);
    return isConnectionLevelError(e) ? new ConnectionError(message) : new QueryError(message);
  }
}

const logger = new Logger("PostgresAdapter");

// A pooled client that errors while idle has no in-flight query to reject,
// so pg emits on the Pool instead. With no listener there, Node treats it
// as an unhandled 'error' event and the API process exits — from something
// entirely routine: a database restart, an admin terminate, a pooler
// recycling an idle connection (Neon and Supabase both do this), or a TCP
// reset. pg's documentation calls the listener out for exactly this
// reason.
//
// Nothing to recover here: pg removes the broken client from the pool
// itself, and the next `query` opens a fresh one. Logging it and staying
// up is the whole job.
export function attachIdleClientErrorHandler(pool: {
  on(event: "error", listener: (e: Error) => void): unknown;
}): void {
  pool.on("error", (e) => {
    logger.warn(`idle pooled client error (connection dropped, pool will recover): ${e.message}`);
  });
}

// Production factory. `pg.Pool` is lazy — it doesn't open a TCP connection
// until the first query — so calling this at registration time is cheap
// and safe (no network involved). The pool's `types` override forces every
// OID to come back as raw text, so `pgOidToValue` is the single source of
// truth for value decoding.
export function createPostgresAdapter(config: PostgresConnectionConfig): PostgresAdapter {
  if (!config.connectionString && !config.host) {
    // Surface as 404 "capability" rather than 500 — the requested
    // connection cannot be served by this adapter as configured.
    throw new CapabilityError(
      "postgres driver requires either connectionString or host (+ database/user)",
    );
  }
  const opts = resolvePostgresPoolOptions(config);
  const poolConfig: PoolConfig = {
    connectionString: opts.connectionString,
    host: opts.host,
    port: opts.port,
    database: opts.database,
    user: opts.user,
    password: opts.password,
    // Explicit ssl wins over whatever sslmode the connectionString URL
    // carries — `resolvePostgresPoolOptions` has already stripped it from
    // the URL for that reason. Only two modes survive resolution and only
    // `disable` turns TLS off; see `hardenSslMode` for why nothing else
    // can (ADR-0078).
    //
    // `rejectUnauthorized: false` encrypts without verifying the chain,
    // which is what `require` means in libpq and in sqlx alike: it defends
    // against passive interception, not against an active attacker holding
    // a wrong certificate. Verification needs a CA the caller can nominate
    // and there is nowhere to put one yet.
    ssl: opts.sslmode === "require" ? { rejectUnauthorized: false } : false,
    max: opts.max,
    idleTimeoutMillis: opts.idleTimeoutMillis,
    query_timeout: opts.query_timeout,
    // Server-side counterpart to query_timeout — pg forwards it in the
    // startup packet, so the server aborts the statement instead of the
    // client merely giving up on it. See the comment on
    // ResolvedPostgresPoolOptions for why both are set.
    statement_timeout: opts.statement_timeout,
    types: {
      // Return every column as raw text; the decoder is the canonical
      // OID → Value map. Avoids depending on pg-types' parser branches
      // (which differ between bool/int8/timestamp).
      getTypeParser: () => (value: string) => value,
    },
  };
  const pool = new Pool(poolConfig);
  attachIdleClientErrorHandler(pool);
  // The config travels with the adapter, not with the registry record: the
  // record is what `GET /connections` is projected from, and the config is
  // the half of the connection that has a password in it (0027 slice G).
  return new PostgresAdapter(pool, config);
}
