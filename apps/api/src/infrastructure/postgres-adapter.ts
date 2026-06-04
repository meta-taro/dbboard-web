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
    fields: { name: string; dataTypeID: number }[];
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
    const message = e instanceof Error ? e.message : String(e);
    return isConnectionLevelError(e) ? new ConnectionError(message) : new QueryError(message);
  }
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
    types: {
      // Return every column as raw text; the decoder is the canonical
      // OID → Value map. Avoids depending on pg-types' parser branches
      // (which differ between bool/int8/timestamp).
      getTypeParser: () => (value: string) => value,
    },
  };
  return new PostgresAdapter(new Pool(poolConfig));
}
