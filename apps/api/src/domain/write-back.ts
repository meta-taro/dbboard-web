/**
 * Pure write-back SQL generation for inline cell editing — the web mirror of
 * desktop's `crates/dbboard-core/src/write_back.rs` (ADR-0042, as shipped in
 * ADR-0063).
 *
 * This is the module that produces the one statement in the product the user
 * did not type and cannot proof-read before it runs. It is `domain`: pure, no
 * I/O, no Nest decorators, so the escaping can be tested adversarially in
 * isolation and the usecase above it has nothing left to get wrong.
 *
 * Safety is by construction, not by trust:
 *
 * - **Identifiers** are double-quoted with the embedded quote doubled.
 * - **Edited values** are single-quoted literals with `'` doubled, or the
 *   bare keyword `NULL`. The editor produces text and only text, so every
 *   value goes out as a string literal and the engine coerces it by the
 *   target column's type (Postgres assignment cast from an `unknown`
 *   literal). `NULL` is the one value that is not text, and it gets its own
 *   variant rather than being spelled as an empty string.
 * - **Identity values** arrive typed from the row, so the `WHERE` key encodes
 *   them by their real type — bare number, quoted text, or `IS NULL` — rather
 *   than round-tripping through text and hoping for a cast.
 *
 * No user text is ever concatenated unescaped.
 *
 * The dialect parameter these functions promised in rung 6 arrived in rung 7
 * slice C, on the same functions rather than as a second copy of them. It is
 * **required**, not defaulted: a default is how the caller that forgot gets
 * Postgres escaping silently, which is the failure mode the dump path already
 * demonstrated once (see {@link SqlDialect}'s note on the fallback).
 *
 * One deliberate narrowing against the desktop original remains, from
 * ADR-0063: **no `rowid` row identity.** Decision 2 keeps only the declared
 * primary key, so `RowKey` is a plain array rather than a union. Web now does
 * ship SQLite-family adapters — Turso and D1, rung 7 slices A and B — and the
 * narrowing survives them because it was never about which engines were
 * present. A `rowid` key needs the browse query to have selected `rowid`
 * explicitly, and `selectTopN` emits `SELECT *`, which does not include it.
 */
import { type SqlDialect } from "./dialect";
import type { TableInfo } from "./values/table-info";
import type { TableSchema } from "./values/table-schema";
import type { Value } from "./values/value";
import { isBlobValue } from "./values/value";

/** A staged new value for one cell. */
export type CellValue =
  /** Text from the editor, emitted as a `'…'` literal and coerced by the
   * target column's type. */
  | { kind: "text"; text: string }
  /** Explicit SQL `NULL` — never "empty string standing in for null". */
  | { kind: "null" };

/** One identity column paired with the row's **original** value. */
export interface KeyColumn {
  column: string;
  value: Value;
}

/** One column that changed, with its new value. */
export interface ColumnEdit {
  column: string;
  value: CellValue;
}

/**
 * A single-row `UPDATE`: the base table, the `WHERE` key, and the columns
 * that changed.
 *
 * `edits` order is preserved in the emitted `SET` clause so output is
 * deterministic — stable tests, and a history entry a human can read.
 */
export interface UpdatePlan {
  table: TableInfo;
  key: KeyColumn[];
  edits: ColumnEdit[];
}

/** Why an {@link UpdatePlan} could not be turned into SQL. */
export enum WriteBackErrorKind {
  /** No columns were edited — there is nothing to write. */
  NoEdits = "no-edits",
  /** The key has no columns. Refusing rather than emitting an unkeyed
   * `UPDATE` that would rewrite the whole table. */
  EmptyKey = "empty-key",
  /** An identity value is a blob, which has no safe literal form for a
   * `WHERE` comparison. */
  UnsupportedKeyType = "unsupported-key-type",
}

export class WriteBackError extends Error {
  constructor(
    readonly kind: WriteBackErrorKind,
    message: string,
  ) {
    super(message);
    this.name = "WriteBackError";
  }
}

/**
 * Quote a SQL identifier for `dialect`, doubling the embedded delimiter.
 *
 * SQLite and Postgres use the standard double quote; MySQL uses back-ticks
 * and doubles an embedded back-tick. Each dialect doubles **only its own**
 * delimiter (ADR-0072 decision 2): a `"` inside a back-quoted MySQL
 * identifier is an ordinary character, and escaping it there would rename the
 * column.
 *
 * Distinct from {@link quoteLiteral} on purpose: the two escape different
 * characters, and using one where the other belongs is exactly the mistake
 * this module exists to make impossible.
 */
export function quoteIdent(ident: string, dialect: SqlDialect): string {
  return dialect === "mysql"
    ? `\`${ident.replace(/`/g, "``")}\``
    : `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Quote a SQL string literal for `dialect`, doubling any embedded single
 * quote.
 *
 * On SQLite and Postgres a backslash is an ordinary character in a standard
 * string literal (`standard_conforming_strings` has been on by default since
 * Postgres 9.1), so doubling it there would store two. MySQL treats it as an
 * escape character unless the server runs with `NO_BACKSLASH_ESCAPES`, so it
 * has to be doubled — and doubled **first**, before the quote escaping, or
 * the backslashes this step adds would themselves be re-escaped by it
 * (ADR-0068 decision 1).
 */
export function quoteLiteral(text: string, dialect: SqlDialect): string {
  const escaped =
    dialect === "mysql"
      ? text.replace(/\\/g, "\\\\").replace(/'/g, "''")
      : text.replace(/'/g, "''");
  return `'${escaped}'`;
}

/**
 * The `UPDATE` target: `"schema"."name"`, or `"name"` when unqualified.
 *
 * SQLite has no schema namespace, so the name stands alone there even if a
 * `schema` slipped into the `TableInfo` — which it should not, since both
 * SQLite-wire adapters report `schema: null` from `listTables`. Desktop draws
 * the same line for the same reason.
 */
export function qualifiedTable(table: TableInfo, dialect: SqlDialect): string {
  return table.schema && dialect !== "sqlite"
    ? `${quoteIdent(table.schema, dialect)}.${quoteIdent(table.name, dialect)}`
    : quoteIdent(table.name, dialect);
}

/** A staged edit as a SQL literal. */
function editLiteral(value: CellValue, dialect: SqlDialect): string {
  return value.kind === "null" ? "NULL" : quoteLiteral(value.text, dialect);
}

/**
 * One `WHERE` predicate, encoding the original value by its real type.
 *
 * `null` becomes `IS NULL` rather than `= NULL`, which is never true. A
 * primary key is never null, but the predicate has to be correct for the
 * unique-key fallback this shape leaves room for.
 */
function keyPredicate(key: KeyColumn, dialect: SqlDialect): string {
  const ident = quoteIdent(key.column, dialect);
  const value = key.value;
  if (value === null) return `${ident} IS NULL`;
  if (typeof value === "number") return `${ident} = ${value}`;
  if (typeof value === "string") return `${ident} = ${quoteLiteral(value, dialect)}`;
  if (isBlobValue(value)) {
    throw new WriteBackError(
      WriteBackErrorKind.UnsupportedKeyType,
      `identity column "${key.column}" has an unsupported (blob) value`,
    );
  }
  // Unreachable for a well-formed `Value`, but a silent fall-through here
  // would emit an unkeyed or malformed predicate — the two outcomes this
  // module is built to prevent.
  throw new WriteBackError(
    WriteBackErrorKind.UnsupportedKeyType,
    `identity column "${key.column}" has an unsupported value`,
  );
}

/**
 * Build a single-row `UPDATE` for `plan`.
 *
 * The output is complete and fully escaped:
 * `UPDATE <table> SET <col> = <lit>, … WHERE <key> [AND …]`.
 *
 * @throws {WriteBackError} `NoEdits` when nothing changed, `EmptyKey` when
 * the key is empty, `UnsupportedKeyType` when an identity value is a blob.
 */
export function buildUpdateSql(plan: UpdatePlan, dialect: SqlDialect): string {
  if (plan.edits.length === 0) {
    throw new WriteBackError(WriteBackErrorKind.NoEdits, "no columns were edited");
  }
  if (plan.key.length === 0) {
    throw new WriteBackError(
      WriteBackErrorKind.EmptyKey,
      "no row-identity columns to key the update on",
    );
  }

  const set = plan.edits
    .map((edit) => `${quoteIdent(edit.column, dialect)} = ${editLiteral(edit.value, dialect)}`)
    .join(", ");
  // `map(keyPredicate)` would hand the callback the array index as its second
  // argument, which is now the dialect parameter. Spelled out on purpose.
  const where = plan.key.map((key) => keyPredicate(key, dialect)).join(" AND ");

  return `UPDATE ${qualifiedTable(plan.table, dialect)} SET ${set} WHERE ${where}`;
}

/**
 * The columns that identify a row of `schema`, in key order — or `null` when
 * the table cannot be edited.
 *
 * Only the declared primary key counts. Postgres has no safe implicit row
 * key (`ctid` moves under a vacuum), and desktop's SQLite `rowid` fallback is
 * not ported: ADR-0063 decision 2 dropped it, and the browse query web sends
 * could not use it anyway — a `rowid` key needs `rowid` to have been selected
 * by name, and `selectTopN` emits `SELECT *`, which excludes it.
 *
 * Reads `primary_key` rather than filtering `columns` by their `primary_key`
 * flag, because only the former is ordered — and for a composite key, the
 * wrong order is a different key.
 */
export function resolveRowIdentity(schema: TableSchema): string[] | null {
  return schema.primary_key.length > 0 ? [...schema.primary_key] : null;
}
