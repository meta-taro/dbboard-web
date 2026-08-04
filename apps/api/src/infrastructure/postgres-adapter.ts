import { Logger } from "@nestjs/common";
import { Pool, type PoolConfig } from "pg";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, ConnectionError, QueryError } from "../domain/errors";
import {
  NULL_CAPABILITIES,
  type Capabilities,
  type Column,
  type QueryResult,
  type TableInfo,
} from "../domain/values";
import {
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
  query(config: { text: string; rowMode?: "array" }): Promise<{
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
  constructor(private readonly pool: PgQueryRunner) {}

  getId(): string {
    return "postgres";
  }

  getCapabilities(): Capabilities {
    return NULL_CAPABILITIES;
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
    // carries. node-pg does not implement libpq's "prefer" (try-then-fall-
    // back) — pg-connection-string maps `sslmode=prefer` to ssl: {} which
    // requires TLS. So we resolve here: require → TLS, disable/prefer → no
    // TLS. Hosts that actually need TLS get caught by the Neon/Supabase
    // auto-upgrade or by the caller passing sslmode=require explicitly.
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
  return new PostgresAdapter(pool);
}
