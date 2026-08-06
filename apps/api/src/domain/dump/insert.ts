/**
 * Multi-row `INSERT` assembly for a logical dump — the web mirror of
 * desktop's `crates/dbboard-core/src/dump/insert.rs` (ADR-0049).
 *
 * One statement per page of rows rather than one per row: a dump of a large
 * table is mostly `INSERT INTO … VALUES` boilerplate otherwise, and a batched
 * statement loads faster. The column list is always written out, so the dump
 * survives a target whose column order differs.
 */
import type { SqlDialect } from "../dialect";
import type { TableInfo } from "../values/table-info";
import type { Value } from "../values/value";
import { qualifiedTable, quoteIdent } from "../write-back";
import { valueLiteral } from "./literal";

/**
 * Build one multi-row `INSERT` for `rows` into `table`.
 *
 * Index `i` of each row maps to `columns[i]`. A row shorter than `columns` is
 * padded with `NULL` and a longer one is truncated, rather than throwing: a
 * ragged page means the adapter disagreed with itself about the result shape,
 * and losing the rest of the dump over it is the worse outcome.
 *
 * Returns `null` when there is nothing to emit — no rows, or no columns — so
 * a caller can skip an empty table without producing invalid SQL.
 */
export function buildInsert(
  table: TableInfo,
  columns: string[],
  rows: readonly Value[][],
  dialect: SqlDialect,
): string | null {
  if (columns.length === 0 || rows.length === 0) return null;

  // Spelled out rather than passed by reference: `map(quoteIdent)` would hand
  // the callback the array index as the dialect argument.
  const columnList = columns.map((column) => quoteIdent(column, dialect)).join(", ");
  const tuples = rows
    .map((row) => {
      const cells = columns.map((_, i) =>
        i < row.length ? valueLiteral(row[i]!, dialect) : "NULL",
      );
      return `(${cells.join(", ")})`;
    })
    .join(", ");

  return `INSERT INTO ${qualifiedTable(table, dialect)} (${columnList}) VALUES ${tuples};`;
}
