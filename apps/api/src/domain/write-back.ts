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
 * Two deliberate narrowings against the desktop original, both from ADR-0063:
 *
 * - **No dialect parameter.** Desktop carries `SqlDialect` because it ships
 *   SQLite and MySQL too; web ships the Postgres family only. Backslash
 *   doubling and back-tick identifiers are MySQL's, and they arrive with the
 *   MySQL adapter (ADR-0068) in rung 7 — as a parameter on these same
 *   functions, not as a second copy of them.
 * - **No `rowid` row identity.** ADR-0063 decision 2 keeps only the declared
 *   primary key; the SQLite-rowid variant would be unreachable here, so
 *   `RowKey` is a plain array rather than a union.
 */
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
 * Quote a SQL identifier, doubling any embedded double quote.
 *
 * Distinct from {@link quoteLiteral} on purpose: the two escape different
 * characters, and using one where the other belongs is exactly the mistake
 * this module exists to make impossible.
 */
export function quoteIdent(ident: string): string {
  return `"${ident.replace(/"/g, '""')}"`;
}

/**
 * Quote a SQL string literal, doubling any embedded single quote.
 *
 * A backslash is left alone: Postgres treats it as an ordinary character in a
 * standard string literal (`standard_conforming_strings` has been on by
 * default since 9.1), so doubling it here would store two.
 */
export function quoteLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** The `UPDATE` target: `"schema"."name"`, or `"name"` when unqualified. */
export function qualifiedTable(table: TableInfo): string {
  return table.schema
    ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
    : quoteIdent(table.name);
}

/** A staged edit as a SQL literal. */
function editLiteral(value: CellValue): string {
  return value.kind === "null" ? "NULL" : quoteLiteral(value.text);
}

/**
 * One `WHERE` predicate, encoding the original value by its real type.
 *
 * `null` becomes `IS NULL` rather than `= NULL`, which is never true. A
 * primary key is never null, but the predicate has to be correct for the
 * unique-key fallback this shape leaves room for.
 */
function keyPredicate(key: KeyColumn): string {
  const ident = quoteIdent(key.column);
  const value = key.value;
  if (value === null) return `${ident} IS NULL`;
  if (typeof value === "number") return `${ident} = ${value}`;
  if (typeof value === "string") return `${ident} = ${quoteLiteral(value)}`;
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
export function buildUpdateSql(plan: UpdatePlan): string {
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
    .map((edit) => `${quoteIdent(edit.column)} = ${editLiteral(edit.value)}`)
    .join(", ");
  const where = plan.key.map(keyPredicate).join(" AND ");

  return `UPDATE ${qualifiedTable(plan.table)} SET ${set} WHERE ${where}`;
}

/**
 * The columns that identify a row of `schema`, in key order — or `null` when
 * the table cannot be edited.
 *
 * Only the declared primary key counts. Postgres has no safe implicit row
 * key (`ctid` moves under a vacuum), and desktop's SQLite `rowid` fallback is
 * not ported: ADR-0063 decision 2 dropped it, and web ships no SQLite family
 * adapter for it to apply to.
 *
 * Reads `primary_key` rather than filtering `columns` by their `primary_key`
 * flag, because only the former is ordered — and for a composite key, the
 * wrong order is a different key.
 */
export function resolveRowIdentity(schema: TableSchema): string[] | null {
  return schema.primary_key.length > 0 ? [...schema.primary_key] : null;
}
