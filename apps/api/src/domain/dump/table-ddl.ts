/**
 * `CREATE TABLE` reconstruction from Postgres catalog rows — the web mirror
 * of desktop's `crates/dbboard-postgres/src/table_ddl.rs` (ADR-0049).
 *
 * Postgres has no `sqlite_master`: there is no stored DDL text to read back,
 * so the statement has to be rebuilt from `pg_catalog`. This module is the
 * pure half of that — it takes decoded catalog rows and assembles text. The
 * four queries that produce those rows live in `PostgresAdapter`, because
 * they are I/O; the split mirrors desktop's, and it is what lets the assembly
 * be tested without a database.
 *
 * Most of the hard SQL is not written here. `pg_get_constraintdef` and
 * `pg_get_indexdef` hand back complete, correctly-quoted definitions, and
 * they are emitted **verbatim**. Re-quoting or reformatting them is how a
 * reconstructor corrupts a partial index's `WHERE` clause or an exclusion
 * constraint's operator list. Only the names dbboard controls — schema,
 * table, column, sequence — are quoted here.
 *
 * Sections degrade rather than fail. Aurora DSQL has neither foreign keys nor
 * sequences (desktop ADR-0021), so those catalog queries return nothing and
 * the corresponding sections are simply absent.
 */

/** One column, from `pg_attribute` / `format_type` / `pg_get_expr`. */
export interface ColumnDef {
  name: string;
  /** `format_type(atttypid, atttypmod)` — already canonical, e.g.
   * `character varying(255)`, `numeric(10,2)`. */
  type_name: string;
  not_null: boolean;
  /** `pg_get_expr` of the column default, verbatim, or `null`. */
  default_expr: string | null;
}

/** One table constraint, from `pg_constraint`. `def` is the verbatim
 * `pg_get_constraintdef` body (`PRIMARY KEY (id)`, `CHECK ((n > 0))`, …). */
export interface ConstraintDef {
  name: string;
  def: string;
}

/**
 * One owned sequence, from `pg_sequence`. Emitted ahead of the table so the
 * column default that references it resolves.
 *
 * The bounds are **strings**, not numbers. `bigint` sequence bounds reach
 * ±9223372036854775808, past `Number.MAX_SAFE_INTEGER`; decoding one as a
 * number and rendering it back produces a value Postgres rejects as out of
 * range. They are validated as integral before interpolation.
 */
export interface SequenceDef {
  schema: string;
  name: string;
  /** `format_type` of the element type: `bigint`, `integer`, `smallint`. */
  type_name: string;
  start: string;
  increment: string;
  min_value: string;
  max_value: string;
  cache: string;
  cycle: boolean;
}

/** The decoded inputs for one table's DDL. Every list but `columns` may be
 * empty. */
export interface TableDdlParts {
  schema: string;
  table: string;
  columns: ColumnDef[];
  constraints: ConstraintDef[];
  /** Verbatim `pg_get_indexdef` statements for indexes *not* backing a
   * constraint — those are recreated by the constraint itself. */
  indexes: string[];
  sequences: SequenceDef[];
}

/** The catalog rows cannot be assembled into DDL that would re-parse. */
export class TableDdlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TableDdlError";
  }
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

function qualified(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/**
 * A sequence bound, checked to be an integer before it is interpolated.
 *
 * These come from `pg_sequence`'s `int8` columns, so in practice they are
 * always integral. The check is here because this is the one place in the
 * module where a value is spliced into SQL as neither an identifier nor a
 * quoted literal, and "in practice" is not the standard a dump generator
 * should hold itself to.
 */
function integral(value: string, field: string): string {
  if (!/^-?\d+$/.test(value)) {
    throw new TableDdlError(`sequence ${field} is not an integer: ${JSON.stringify(value)}`);
  }
  return value;
}

function renderColumn(col: ColumnDef): string {
  let line = `${quoteIdent(col.name)} ${col.type_name}`;
  if (col.not_null) line += " NOT NULL";
  if (col.default_expr !== null) line += ` DEFAULT ${col.default_expr}`;
  return line;
}

function renderSequence(seq: SequenceDef): string {
  const stmt =
    `CREATE SEQUENCE ${qualified(seq.schema, seq.name)} AS ${seq.type_name}` +
    ` START WITH ${integral(seq.start, "start")}` +
    ` INCREMENT BY ${integral(seq.increment, "increment")}` +
    ` MINVALUE ${integral(seq.min_value, "min_value")}` +
    ` MAXVALUE ${integral(seq.max_value, "max_value")}` +
    ` CACHE ${integral(seq.cache, "cache")}`;
  return `${stmt}${seq.cycle ? " CYCLE" : ""};`;
}

/**
 * Assemble the full DDL for one table: owned sequences first, then the
 * `CREATE TABLE` (columns, then inline constraints), then standalone indexes.
 * Every statement is `;`-terminated and newline-separated.
 *
 * @throws {TableDdlError} when the table has no columns (which means the
 * catalog query found no such relation, not a table with nothing in it), or a
 * sequence bound is not integral.
 */
export function assembleTableDdl(parts: TableDdlParts): string {
  if (parts.columns.length === 0) {
    throw new TableDdlError(`relation "${parts.schema}.${parts.table}" has no columns`);
  }

  let out = "";
  for (const seq of parts.sequences) out += `${renderSequence(seq)}\n`;

  const items = [
    ...parts.columns.map(renderColumn),
    ...parts.constraints.map((con) => `CONSTRAINT ${quoteIdent(con.name)} ${con.def}`),
  ];
  out += `CREATE TABLE ${qualified(parts.schema, parts.table)} (\n`;
  out += items.map((item) => `    ${item}`).join(",\n");
  out += "\n);\n";

  for (const index of parts.indexes) out += `${index.trimEnd()};\n`;

  return out;
}
