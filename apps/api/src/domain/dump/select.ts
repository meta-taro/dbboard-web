/**
 * Keyset-paginated `SELECT` assembly for a logical dump — the web mirror of
 * desktop's `crates/dbboard-core/src/dump/select.rs` (ADR-0049).
 *
 * A dump reads each table one page at a time so no single result set is ever
 * held whole. When the table has a primary key the pages are *keyset*: ordered
 * by the key, each page fetching rows strictly after the previous page's last
 * key via a row-value comparison. Keyset paging stays O(1) per page and is
 * stable under concurrent inserts, unlike `OFFSET`, which re-scans from the
 * top and shifts under you.
 *
 * Cursor values are rendered with the same {@link valueLiteral} the `INSERT`s
 * use, so the cursor and the data agree on how a value is spelled.
 */
import type { SqlDialect } from "../dialect";
import type { TableInfo } from "../values/table-info";
import type { Value } from "../values/value";
import { qualifiedTable, quoteIdent } from "../write-back";
import { valueLiteral } from "./literal";

/** A cursor that cannot be turned into a correct `WHERE`. */
export class CursorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorError";
  }
}

/**
 * Build one page's `SELECT` for `table`.
 *
 * - `keyColumns` is the primary key in key order. When empty the page is an
 *   unordered `SELECT * … LIMIT n` and the caller must not page further —
 *   there is no stable cursor to page with.
 * - `after` is the previous page's last row's key values, positionally
 *   matching `keyColumns`. Omit it for the first page; it is ignored when
 *   `keyColumns` is empty.
 * - `limit` bounds the page size. The caller keeps it under `ROW_CAP`.
 * - `dialect` quotes the identifiers and renders the cursor values. It sits
 *   ahead of `after` because it is required and `after` is not.
 *
 * @throws {CursorError} when `after` does not match the key's arity, or
 * carries a `null`. Desktop renders a null cursor value as the literal `NULL`
 * and moves on; here it is refused, because `(k) > (NULL)` is `NULL`, the page
 * comes back empty, and the rest of the table goes silently missing from a
 * *backup*. A declared primary key is never null, so this can only fire when
 * the read and the schema disagree — and then failing the one table (the
 * dump's partial-failure path) beats writing a plausible-looking short file.
 */
export function buildSelectPage(
  table: TableInfo,
  keyColumns: string[],
  limit: number,
  dialect: SqlDialect,
  after?: readonly Value[],
): string {
  let sql = `SELECT * FROM ${qualifiedTable(table, dialect)}`;

  if (keyColumns.length > 0) {
    const keyList = keyColumns.map((column) => quoteIdent(column, dialect)).join(", ");

    if (after !== undefined) {
      if (after.length !== keyColumns.length) {
        throw new CursorError(
          `cursor has ${after.length} value(s) for a ${keyColumns.length}-column key`,
        );
      }
      if (after.some((value) => value === null)) {
        throw new CursorError("cursor contains a null; a keyed page cannot resume past it");
      }
      const cursor = after.map((value) => valueLiteral(value, dialect)).join(", ");
      sql += ` WHERE (${keyList}) > (${cursor})`;
    }

    sql += ` ORDER BY ${keyList}`;
  }

  return `${sql} LIMIT ${limit}`;
}

/**
 * Build the preflight `SELECT COUNT(*)` for `table`.
 *
 * The planning pass runs one per table to size the dump and feed the
 * large-database gate. Identifier quoting matches {@link buildSelectPage} so
 * the same table is addressed identically in the count and the paged reads.
 */
export function buildCount(table: TableInfo, dialect: SqlDialect): string {
  return `SELECT COUNT(*) FROM ${qualifiedTable(table, dialect)}`;
}
