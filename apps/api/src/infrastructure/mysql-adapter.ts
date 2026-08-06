/**
 * MySQL / MariaDB adapter — the web mirror of desktop's
 * `crates/dbboard-mysql/src/lib.rs` (ADR-0068), read at `main` = b98f7a6.
 *
 * Desktop drives MySQL through sqlx; this drives it through `mysql2`. The
 * mirror is of the **behaviour**, not of the driver: the same catalog
 * queries, the same identifier quoting, the same byte-level value decoding,
 * the same TLS hardening, and the same refusal to let a connection URL reach
 * an error message. Where the two runtimes disagree, the comment says so.
 *
 * ## What is deliberately not ported
 *
 * Desktop's trait is wider than web's {@link DatabaseAdapter}, and the parts
 * with no hook to hang off are absent rather than written and unused:
 * `ping`, `foreign_keys`, and — the large one — `query_read_only` with its
 * `TimeoutStyle` machinery. That machinery exists because a read-only query
 * needs a server-side statement timeout, and MySQL 5.7.8+ spells it
 * `max_execution_time` (milliseconds), MariaDB spells it `max_statement_time`
 * (seconds), and MySQL 5.6 has neither — so desktop probes once and caches
 * which one the server understands. Web has no read-only route, so there is
 * nothing for the probe to protect and no reason to carry three spellings of
 * a variable this adapter never sets.
 */
import { createPool } from "mysql2/promise";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import {
  CapabilityError,
  CategorizedError,
  ConnectionError,
  QueryError,
  SchemaError,
  TypeConversionError,
} from "../domain/errors";
import {
  encodeBlob,
  NULL_CAPABILITIES,
  type Capabilities,
  type ColumnInfo,
  type QueryResult,
  type TableInfo,
  type TableSchema,
  type Value,
} from "../domain/values";
import type { AdapterConfig } from "../usecase/adapter-factory.port";

/** Desktop's `MAX_CONNECTIONS`. A desktop client and a single-tenant API
 * server want the same thing here: enough to overlap a dump's paged reads,
 * few enough not to be noticed by a shared server. */
const MAX_CONNECTIONS = 5;

/** Desktop's `MAX_ERROR_DETAIL`. A server error message is attacker-shaped
 * data — it can quote the statement back, and a statement can be a megabyte. */
const MAX_ERROR_DETAIL = 2048;

const DEFAULT_PORT = 3306;

/**
 * The one thing an unparseable URL is ever allowed to say. Desktop reduces
 * sqlx's `Configuration` error to a fixed string for the same reason: the
 * source of that error embeds the password, and sqlx puts it in the message.
 */
const INVALID_CONFIG = "invalid MySQL connection configuration";

// The catalog queries, verbatim from desktop apart from whitespace.
//
// `DATABASE()` rather than a `?` for the current schema: a MySQL connection
// is bound to one database, and `information_schema` is the only catalog
// there is — so "the tables" means "this database's tables", and there is no
// second namespace to offer the caller.
const LIST_TABLES_SQL = `SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'
ORDER BY table_name`;

// `CAST(ordinal_position AS SIGNED)` is desktop's, and it is load-bearing:
// since MySQL 8.0 the information_schema is a view over the data dictionary
// and this column's own type varies by server, so the cast is what makes it
// readable the same way everywhere.
const DESCRIBE_COLUMNS_SQL = `SELECT column_name, column_type, is_nullable, column_default,
       CAST(ordinal_position AS SIGNED)
FROM information_schema.columns
WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
ORDER BY ordinal_position`;

// `ORDER BY ordinal_position` here is the position **within the key**, not
// within the table — `key_column_usage.ordinal_position` is the key's own
// column order, which for a composite key is the order the index is built in
// and is not recoverable from the column list.
const DESCRIBE_PK_SQL = `SELECT column_name
FROM information_schema.key_column_usage
WHERE table_schema = COALESCE(?, DATABASE()) AND table_name = ?
  AND constraint_name = 'PRIMARY'
ORDER BY ordinal_position`;

/**
 * One result column's protocol metadata.
 *
 * `type`, `characterSet` and `flags` are optional because they are only ever
 * read to *name* the column's type: a stub that does not care what the type
 * is may leave them out, and a real server that sends a code this adapter
 * does not know is treated the same way — as no declared type rather than as
 * a wrong one.
 */
export interface MySqlColumnMeta {
  name: string;
  /** The protocol type code (mysql2's `Types` enum). */
  type?: number;
  /** The column's character set id; 63 is `binary`, which is what tells
   * `BLOB` apart from `TEXT` — the protocol gives both the same type code. */
  characterSet?: number;
  /** The column flag bitfield; bit 32 is `UNSIGNED`. */
  flags?: number;
}

/**
 * One statement's result, with every cell still in the bytes MySQL printed.
 *
 * Decoding is this module's job, not the driver's, because desktop decides
 * text-vs-blob from the bytes rather than from the declared type and doing
 * the same requires seeing them. See {@link decodeCell}.
 */
export interface MySqlRead {
  columns: MySqlColumnMeta[];
  rows: (Uint8Array | null)[][];
  affectedRows: number;
}

/**
 * The seam between this adapter and `mysql2`.
 *
 * Narrow and normalizing rather than a structural subset of the driver's own
 * type, which `PostgresAdapter` gets away with: mysql2's `query` is a stack
 * of overloads whose return type depends on the option object, and a subset
 * of it would be a re-declaration of that stack rather than a seam. The only
 * implementation that touches the driver is {@link Mysql2Pool}.
 */
export interface MySqlPool {
  /** Run one statement and buffer its result. `values` are bound as
   * placeholders and are never interpolated. */
  read(sql: string, values?: readonly unknown[]): Promise<MySqlRead>;
  /** Take one connection out of the pool, for a transaction. */
  session(): Promise<MySqlSession>;
  close(): Promise<void>;
}

/** One connection held for the duration of a transaction. */
export interface MySqlSession {
  run(sql: string): Promise<void>;
  /** Return the connection to the pool. */
  release(): void;
  /** Drop the connection instead of returning it — for when its state is
   * unknown and reusing it would hand the next caller an open transaction. */
  destroy(): void;
}

/** The subset of mysql2's pool this module drives. Declared here so the
 * import of `mysql2` stays inside {@link Mysql2Pool}. */
interface Mysql2Driver {
  query(options: {
    sql: string;
    values?: readonly unknown[];
    rowsAsArray: true;
    typeCast: (field: Mysql2Field, next: () => unknown) => unknown;
  }): Promise<[unknown, unknown]>;
  getConnection(): Promise<Mysql2Connection>;
  end(): Promise<void>;
}

interface Mysql2Field {
  name: string;
  type: number;
  characterSet: number;
  flags: number;
  buffer(): Buffer | null;
}

interface Mysql2Connection {
  query(sql: string): Promise<unknown>;
  release(): void;
  destroy(): void;
}

/**
 * The only class that touches `mysql2`.
 *
 * Two driver choices here are not incidental:
 *
 * - **`query`, not `execute`.** `execute` uses the binary protocol, where a
 *   value arrives in its type's own encoding and `field.buffer()` hands back
 *   those raw bytes. `query` uses the text protocol, where every value is the
 *   text MySQL would print — which is what desktop's sqlx `raw_sql` path
 *   sees, and what makes `decode_cell`'s "valid UTF-8 or blob" rule mean the
 *   same thing here.
 * - **`typeCast: (field) => field.buffer()`.** Without it mysql2 converts
 *   each cell to a JS type using the declared column type, which loses the
 *   distinction desktop keeps: a `BLOB` holding valid UTF-8 is text, and a
 *   `VARCHAR` holding invalid UTF-8 is not.
 */
export class Mysql2Pool implements MySqlPool {
  constructor(private readonly driver: Mysql2Driver) {}

  async read(sql: string, values?: readonly unknown[]): Promise<MySqlRead> {
    const [rows, fields] = await this.driver.query({
      sql,
      values,
      rowsAsArray: true,
      typeCast: (field) => field.buffer(),
    });
    return normalizeRead(rows, fields);
  }

  async session(): Promise<MySqlSession> {
    const connection = await this.driver.getConnection();
    return {
      run: async (sql: string) => {
        await connection.query(sql);
      },
      release: () => connection.release(),
      destroy: () => connection.destroy(),
    };
  }

  async close(): Promise<void> {
    await this.driver.end();
  }
}

/**
 * Reshape one mysql2 result into a {@link MySqlRead}.
 *
 * A row-returning statement answers `[rows, fields]`; a write answers an OK
 * packet with `affectedRows` and no fields. Both shapes arrive through the
 * same call, so which one this is has to be read off the value.
 */
function normalizeRead(rows: unknown, fields: unknown): MySqlRead {
  const columns = Array.isArray(fields)
    ? (fields as Mysql2Field[]).map((f) => ({
        name: f.name,
        type: f.type,
        characterSet: f.characterSet,
        flags: f.flags,
      }))
    : [];
  if (!Array.isArray(rows)) {
    const affected = (rows as { affectedRows?: unknown } | null)?.affectedRows;
    return { columns, rows: [], affectedRows: typeof affected === "number" ? affected : 0 };
  }
  const decoded = (rows as unknown[][]).map((row) =>
    row.map((cell) =>
      cell === null || cell === undefined ? null : new Uint8Array(cell as Buffer),
    ),
  );
  return { columns, rows: decoded, affectedRows: 0 };
}

/** How the connection should be encrypted, in the shape Node's TLS stack
 * takes. `undefined` means no TLS at all. */
export interface MySqlTlsOptions {
  rejectUnauthorized: boolean;
}

/** A connection URL, decomposed into the fields the driver takes. */
export interface ResolvedMySqlPoolOptions {
  host: string;
  port: number;
  user?: string;
  password?: string;
  database?: string;
  ssl?: MySqlTlsOptions;
  connectionLimit: number;
}

/**
 * Parse a `mysql://` (or `mariadb://`) URL into pool options, hardening the
 * TLS policy on the way through.
 *
 * The URL is **decomposed** rather than handed to the driver whole, for the
 * same reason `resolvePostgresPoolOptions` strips `sslmode`: it makes the
 * `ssl` field the single source of truth about encryption, instead of leaving
 * a query parameter in the string that the driver might read differently.
 *
 * ## The TLS default is the point
 *
 * Desktop's `harden_ssl_mode` exists because sqlx defaults an unstated
 * `ssl-mode` to `Preferred`, which silently falls back to plaintext when the
 * server does not offer TLS — sending the password in the clear, with no
 * error. mysql2's default is worse: no TLS at all, ever. So absent,
 * `PREFERRED` and `REQUIRED` all resolve to an encrypted connection, and an
 * explicit choice in either direction is preserved — `DISABLED` for a
 * deliberately insecure local node, `VERIFY_CA` / `VERIFY_IDENTITY` for a
 * caller who wants the certificate checked.
 *
 * `REQUIRED` maps to `rejectUnauthorized: false`, which is what the word
 * means in MySQL's vocabulary: encrypt, do not verify. It is weaker than
 * verification and stronger than the plaintext it replaces, and it is the
 * strongest thing available while there is nowhere in the connection config
 * to nominate a CA.
 *
 * @throws {CapabilityError} for anything unparseable — with a fixed message,
 * never the URL, which embeds the password.
 */
export function resolveMySqlPoolOptions(connectionString: string): ResolvedMySqlPoolOptions {
  const url = parseMySqlUrl(connectionString);
  if (url === null) throw new CapabilityError(INVALID_CONFIG);

  // `URL.hostname` keeps an IPv6 address's brackets; the driver wants the
  // address itself.
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host === "") throw new CapabilityError(INVALID_CONFIG);

  const port = url.port === "" ? DEFAULT_PORT : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CapabilityError(INVALID_CONFIG);
  }

  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));

  return {
    host,
    port,
    // `URL` keeps the credential percent-encoded; the driver wants it raw,
    // so a password with an `@` or a `/` in it survives the round trip.
    ...(url.username === "" ? {} : { user: decodeURIComponent(url.username) }),
    ...(url.password === "" ? {} : { password: decodeURIComponent(url.password) }),
    ...(database === "" ? {} : { database }),
    ...(resolveTls(url) ?? {}),
    connectionLimit: MAX_CONNECTIONS,
  };
}

function parseMySqlUrl(connectionString: string): URL | null {
  const trimmed = connectionString.trim();
  if (trimmed === "") return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  return url.protocol === "mysql:" || url.protocol === "mariadb:" ? url : null;
}

function resolveTls(url: URL): { ssl: MySqlTlsOptions } | null {
  const raw = url.searchParams.get("ssl-mode");
  const mode = (raw ?? "").trim().toUpperCase().replace(/-/g, "_");
  switch (mode) {
    case "":
    case "PREFERRED":
    case "REQUIRED":
      return { ssl: { rejectUnauthorized: false } };
    case "DISABLED":
      return null;
    case "VERIFY_CA":
    case "VERIFY_IDENTITY":
      return { ssl: { rejectUnauthorized: true } };
    default:
      throw new CapabilityError(INVALID_CONFIG);
  }
}

/**
 * Graft the stored password onto an edited URL that does not state one —
 * ADR-0080 decision 3, the same rule `carryCredential` applies to Postgres.
 *
 * The browser is shown where a connection points but never the credential,
 * so a save that left the password box alone arrives with no password. That
 * is an omission, not a removal: a URL that states a password replaces the
 * stored one, and a URL that states none keeps it.
 *
 * Setting it through the `URL` object rather than by string surgery is what
 * percent-encodes a password containing `@` or `/`.
 */
export function carryMySqlCredential(previous: string, next: string): string {
  const target = parseMySqlUrl(next);
  // An unparseable edit is passed through untouched so the factory is the
  // one place that reports it, rather than this function inventing a second
  // error for the same cause.
  if (target === null || target.password !== "") return next;
  const source = parseMySqlUrl(previous);
  if (source === null || source.password === "") return next;
  target.password = source.password;
  return target.toString();
}

export class MySqlAdapter implements DatabaseAdapter {
  /**
   * @param pool the driver seam.
   * @param secret the connection password, so it can be scrubbed out of a
   * message the driver built from the URL. Absent for a stub.
   * @param url the connection URL, kept only so {@link rebuildWith} can carry
   * the password forward across an edit.
   */
  constructor(
    private readonly pool: MySqlPool,
    private readonly secret?: string,
    private readonly url?: string,
  ) {}

  getId(): string {
    return "mysql";
  }

  getCapabilities(): Capabilities {
    return {
      ...NULL_CAPABILITIES,
      has_describe_table: true,
      has_table_ddl: true,
      has_execute: true,
      // A DDL statement causes an implicit commit in MySQL, which would
      // break the all-or-nothing promise — but dbboard's logical dump is
      // data-only (ADR-0049), so a restore script emits none, and for data
      // an InnoDB transaction is exactly atomic.
      has_atomic_restore: true,
    };
  }

  async listTables(): Promise<TableInfo[]> {
    const result = await this.introspect(LIST_TABLES_SQL);
    return result.rows.map((row) => ({
      schema: this.text(row, 0),
      name: this.text(row, 1),
    }));
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    const result = await this.read(sql);
    const rows = result.rows.map((row) => row.map((cell) => decodeCell(cell)));
    return {
      columns: result.columns.map((column) => ({
        name: column.name,
        declared_type: typeNameOf(column),
      })),
      rows,
      // Desktop's rule: a row-returning statement reports 0, because
      // `rows_affected` is load-bearing on DML only and MySQL's OK packet
      // reports a row count there for a SELECT.
      rows_affected: rows.length === 0 ? result.affectedRows : 0,
    };
  }

  async describeTable(table: TableInfo): Promise<TableSchema> {
    // NULL rather than a guessed name for an unqualified table: COALESCE
    // resolves it to whichever database the connection is bound to.
    const bindings = [table.schema, table.name];

    const columns = await this.introspect(DESCRIBE_COLUMNS_SQL, bindings);
    if (columns.rows.length === 0) {
      // information_schema answers an unknown table with an empty set rather
      // than an error, and a table with no columns cannot exist — so this is
      // the only reading, and it is the caller's mistake rather than the
      // schema's, which is why it stays a QueryError.
      throw new QueryError(`table \`${table.name}\` does not exist`);
    }

    const primaryKey = (await this.introspect(DESCRIBE_PK_SQL, bindings)).rows.map((row) =>
      this.text(row, 0),
    );
    const keyed = new Set(primaryKey);

    return {
      table,
      columns: columns.rows.map((row) => this.columnFrom(row, keyed)),
      primary_key: primaryKey,
    };
  }

  async tableDdl(table: TableInfo): Promise<string> {
    // SHOW takes no placeholders, so the identifier is interpolated — which
    // is why `quoteIdent` doubling an embedded back-tick is the whole of the
    // defence here.
    const result = await this.read(`SHOW CREATE TABLE ${qualifiedIdent(table)}`);
    const row = result.rows[0];
    if (row === undefined) throw new QueryError(`table \`${table.name}\` does not exist`);
    // Column 0 is the table name. Reading it would emit a dump whose every
    // CREATE statement is the word `users`.
    return this.text(row, 1);
  }

  async execute(sql: string): Promise<number> {
    return (await this.executeQuery(sql)).rows_affected;
  }

  async executeInTransaction(statements: readonly string[]): Promise<void> {
    if (statements.length === 0) return;

    let session: MySqlSession;
    try {
      session = await this.pool.session();
    } catch (error) {
      throw this.translate(error);
    }

    try {
      // One connection for the whole batch — a pooled `query` per statement
      // would spread them across connections and there would be no
      // transaction at all.
      await session.run("BEGIN");
      for (const sql of statements) await session.run(sql);
      await session.run("COMMIT");
      session.release();
    } catch (error) {
      try {
        await session.run("ROLLBACK");
        session.release();
      } catch {
        // The rollback did not land, so the connection's state is unknown;
        // returning it to the pool would hand the next caller an open
        // transaction. The original failure is the one that gets reported —
        // the rollback's is a consequence of it.
        session.destroy();
      }
      throw this.translate(error);
    }
  }

  async close(): Promise<void> {
    await this.pool.close();
  }

  /**
   * A new adapter pointed at `config`, keeping this one's password when the
   * edited URL does not state one (ADR-0080). The old adapter is not closed
   * here — the caller owns both handles and decides when the old pool goes.
   */
  rebuildWith(config: AdapterConfig): MySqlAdapter {
    const next = config.connectionString ?? "";
    return createMySqlAdapter({
      ...config,
      connectionString: this.url === undefined ? next : carryMySqlCredential(this.url, next),
    });
  }

  /** One statement, with driver errors translated into domain errors. */
  private async read(sql: string, values?: readonly unknown[]): Promise<MySqlRead> {
    try {
      return await this.pool.read(sql, values);
    } catch (error) {
      throw this.translate(error);
    }
  }

  /**
   * A catalog read. Desktop's `reclassify_schema`: the caller did not write
   * this SQL, so reporting its failure as their query error points at the
   * wrong thing. A connection failure is left alone — a dead server is not a
   * malformed schema.
   */
  private async introspect(sql: string, values?: readonly unknown[]): Promise<MySqlRead> {
    try {
      return await this.pool.read(sql, values);
    } catch (error) {
      const translated = this.translate(error);
      throw translated instanceof ConnectionError
        ? translated
        : new SchemaError(translated.message);
    }
  }

  private columnFrom(row: readonly (Uint8Array | null)[], keyed: ReadonlySet<string>): ColumnInfo {
    const name = this.text(row, 0);
    const ordinal = Number(this.text(row, 4));
    if (!Number.isInteger(ordinal) || ordinal < 1) {
      throw new TypeConversionError(
        `non-positive ordinal_position ${this.text(row, 4)} for column ${name}`,
      );
    }
    return {
      name,
      declared_type: this.text(row, 1),
      // "YES" is the SQL-standard spelling, compared case-insensitively
      // because not every server agrees on the case.
      nullable: this.text(row, 2).toUpperCase() === "YES",
      primary_key: keyed.has(name),
      ordinal,
      default_value: this.optionalText(row, 3),
    };
  }

  /**
   * A metadata cell, as text.
   *
   * Read as bytes and decoded here rather than left to the driver because
   * since MySQL 8.0 the information_schema is served from the data
   * dictionary, where `TABLE_NAME` is `VARBINARY` and `DATA_TYPE` is `BLOB` —
   * so a driver that decodes by declared type hands back a buffer for a
   * perfectly good UTF-8 identifier.
   *
   * Unlike a result cell, metadata that is not valid UTF-8 is an **error**
   * rather than a blob: a name the caller cannot address the object with is
   * worse than no answer.
   */
  private text(row: readonly (Uint8Array | null)[], index: number): string {
    const value = this.optionalText(row, index);
    if (value === null) {
      throw new SchemaError(
        `information_schema returned NULL for column ${index}, which is declared NOT NULL`,
      );
    }
    return value;
  }

  private optionalText(row: readonly (Uint8Array | null)[], index: number): string | null {
    const cell = row[index];
    if (cell === undefined || cell === null) return null;
    const text = decodeUtf8(cell);
    if (text === null) {
      throw new SchemaError(`information_schema column ${index} is not valid UTF-8`);
    }
    return text;
  }

  /**
   * Map a driver error onto the contract's categories.
   *
   * **A documented divergence from desktop.** sqlx surfaces every
   * server-reported error as `Database`, which desktop's `classify_error`
   * turns into `Query` — access-denied included. Web splits the
   * connection-refusal class back out, following the rule stated in
   * `turso-adapter.ts`: a 502 which turns out to be a bad query misleads far
   * less than a 400 which turns out to be a dead server. Reporting a wrong
   * password as the caller's SQL error blames a statement they may not even
   * have run yet.
   */
  private translate(error: unknown): Error {
    // A domain error raised inside a callback (a decode failure during a
    // read) is already the answer; re-classifying it would relabel it.
    if (error instanceof CategorizedError) return error;

    const code = (error as { code?: unknown } | null)?.code;
    const errno = (error as { errno?: unknown } | null)?.errno;
    const message = this.redact(truncate(messageOf(error)));

    if (typeof errno === "number" && REFUSAL_ERRNOS.has(errno)) {
      return new ConnectionError(message);
    }
    // A server error carries an errno; a Node socket failure carries only a
    // string code. The absence of an errno is what says "never reached the
    // server".
    if (typeof errno !== "number" && typeof code === "string") {
      return new ConnectionError(message);
    }
    return new QueryError(message);
  }

  /** Blank out the password wherever the driver echoed the URL back. */
  private redact(message: string): string {
    if (this.secret === undefined || this.secret === "") return message;
    return message.split(this.secret).join("***");
  }
}

/**
 * Server errnos that mean "this connection is not going to work", as opposed
 * to "this statement is wrong". Deliberately short: everything not listed
 * stays a query error, because over-reporting connection failures would make
 * a typo look like an outage.
 */
const REFUSAL_ERRNOS = new Set([
  1040, // ER_CON_COUNT_ERROR — too many connections
  1044, // ER_DBACCESS_DENIED_ERROR
  1045, // ER_ACCESS_DENIED_ERROR
  1049, // ER_BAD_DB_ERROR — unknown database
  1129, // ER_HOST_IS_BLOCKED
  1130, // ER_HOST_NOT_PRIVILEGED
  1226, // ER_USER_RESOURCE_LIMIT
  1251, // ER_NOT_SUPPORTED_AUTH_MODE
]);

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === "string" ? error : "unknown MySQL driver error";
}

/** Truncate on a character boundary — the string may be a quoted statement,
 * and cutting a surrogate pair in half produces a lone surrogate that not
 * every JSON consumer survives. */
function truncate(message: string): string {
  if (message.length <= MAX_ERROR_DETAIL) return message;
  return `${Array.from(message).slice(0, MAX_ERROR_DETAIL).join("")}…`;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * One result cell.
 *
 * Under the text protocol every value arrives as the bytes MySQL would
 * print, so UTF-8 validity — not the declared type — is what decides. That is
 * desktop's `decode_cell`, and it is deliberate in both: a `BLOB` holding
 * valid UTF-8 is readable text and shows as text, and a `VARCHAR` holding
 * bytes that are not UTF-8 (a mislabelled column, a latin1 table read as
 * utf8) reaches the client intact as a blob instead of as replacement
 * characters.
 */
function decodeCell(cell: Uint8Array | null): Value {
  if (cell === null) return null;
  return decodeUtf8(cell) ?? encodeBlob(cell);
}

// Protocol type codes. mysql2 exposes these as its `Types` enum; they are
// spelled out here so the module does not import a value from the driver.
const T_DECIMAL = 0;
const T_TINY = 1;
const T_SHORT = 2;
const T_LONG = 3;
const T_FLOAT = 4;
const T_DOUBLE = 5;
const T_NULL = 6;
const T_TIMESTAMP = 7;
const T_LONGLONG = 8;
const T_INT24 = 9;
const T_DATE = 10;
const T_TIME = 11;
const T_DATETIME = 12;
const T_YEAR = 13;
const T_NEWDATE = 14;
const T_VARCHAR = 15;
const T_BIT = 16;
const T_TIMESTAMP2 = 17;
const T_DATETIME2 = 18;
const T_TIME2 = 19;
const T_JSON = 245;
const T_NEWDECIMAL = 246;
const T_ENUM = 247;
const T_SET = 248;
const T_TINY_BLOB = 249;
const T_MEDIUM_BLOB = 250;
const T_LONG_BLOB = 251;
const T_BLOB = 252;
const T_VAR_STRING = 253;
const T_STRING = 254;
const T_GEOMETRY = 255;

/** The `binary` character set id. It is the only thing that tells a binary
 * column from a text one — the protocol gives `BLOB` and `TEXT` the same
 * type code, and likewise `BINARY`/`CHAR` and `VARBINARY`/`VARCHAR`. */
const BINARY_CHARSET = 63;

const UNSIGNED_FLAG = 32;

const INTEGER_NAMES = new Map<number, string>([
  [T_TINY, "TINYINT"],
  [T_SHORT, "SMALLINT"],
  [T_INT24, "MEDIUMINT"],
  [T_LONG, "INT"],
  [T_LONGLONG, "BIGINT"],
]);

const SIMPLE_NAMES = new Map<number, string>([
  [T_DECIMAL, "DECIMAL"],
  [T_NEWDECIMAL, "DECIMAL"],
  [T_FLOAT, "FLOAT"],
  [T_DOUBLE, "DOUBLE"],
  [T_NULL, "NULL"],
  [T_TIMESTAMP, "TIMESTAMP"],
  [T_TIMESTAMP2, "TIMESTAMP"],
  [T_DATE, "DATE"],
  [T_NEWDATE, "DATE"],
  [T_TIME, "TIME"],
  [T_TIME2, "TIME"],
  [T_DATETIME, "DATETIME"],
  [T_DATETIME2, "DATETIME"],
  [T_YEAR, "YEAR"],
  [T_BIT, "BIT"],
  [T_JSON, "JSON"],
  [T_ENUM, "ENUM"],
  [T_SET, "SET"],
  [T_GEOMETRY, "GEOMETRY"],
]);

/** Text/binary pairs, keyed by type code: `[text name, binary name]`. */
const CHARSET_DEPENDENT_NAMES = new Map<number, readonly [string, string]>([
  [T_VARCHAR, ["VARCHAR", "VARBINARY"]],
  [T_VAR_STRING, ["VARCHAR", "VARBINARY"]],
  [T_STRING, ["CHAR", "BINARY"]],
  [T_TINY_BLOB, ["TINYTEXT", "TINYBLOB"]],
  [T_MEDIUM_BLOB, ["MEDIUMTEXT", "MEDIUMBLOB"]],
  [T_LONG_BLOB, ["LONGTEXT", "LONGBLOB"]],
  [T_BLOB, ["TEXT", "BLOB"]],
]);

/**
 * The column's declared type, named the way sqlx's `MySqlTypeInfo` names it,
 * so a web client and a desktop client describing the same table agree.
 *
 * A code this map does not know is reported as `null` rather than as a
 * guess: `declared_type` is displayed to the operator, and a wrong type name
 * is worse than an absent one.
 */
function typeNameOf(column: MySqlColumnMeta): string | null {
  const { type } = column;
  if (type === undefined) return null;

  const integer = INTEGER_NAMES.get(type);
  if (integer !== undefined) {
    return ((column.flags ?? 0) & UNSIGNED_FLAG) === 0 ? integer : `${integer} UNSIGNED`;
  }

  const pair = CHARSET_DEPENDENT_NAMES.get(type);
  if (pair !== undefined) return column.characterSet === BINARY_CHARSET ? pair[1] : pair[0];

  return SIMPLE_NAMES.get(type) ?? null;
}

/** Back-quote an identifier, doubling any back-tick inside it. MySQL reads
 * `"orders"` as a string literal unless `ANSI_QUOTES` is set, so this is the
 * only quoting that works on a default server. */
function quoteIdent(ident: string): string {
  return `\`${ident.replace(/`/g, "``")}\``;
}

function qualifiedIdent(table: TableInfo): string {
  return table.schema === null || table.schema === ""
    ? quoteIdent(table.name)
    : `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`;
}

/**
 * Build an adapter from a registration config.
 *
 * A missing or unusable connection string is a {@link CapabilityError} — a
 * 404 rather than a 500 — matching the other factories: the request named a
 * driver this server has, configured in a way it cannot serve.
 *
 * The pool is created eagerly but connects lazily: mysql2 opens no socket
 * until the first statement, so this is safe to call on the registration
 * path, where blocking on a handshake would make a typo take a TCP timeout
 * to report.
 */
export function createMySqlAdapter(config: AdapterConfig): MySqlAdapter {
  const connectionString = config.connectionString ?? "";
  // Validated here so a bad URL is reported at registration rather than at
  // the first query, and so `resolveMySqlPoolOptions` is the single place
  // that decides what a URL means.
  const options = resolveMySqlPoolOptions(connectionString);
  // The cast is the seam's whole cost: mysql2's `query` is a stack of
  // overloads whose result type is chosen by the option object, and the two
  // shapes this module actually asks for — `rowsAsArray` with a `typeCast`
  // that returns buffers — are not among the ones its types can express.
  const driver = createPool(options) as unknown as Mysql2Driver;
  return new MySqlAdapter(new Mysql2Pool(driver), options.password, connectionString.trim());
}
