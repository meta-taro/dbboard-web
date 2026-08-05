/**
 * Dump sizing: per-table row counts, the large-database gate, and the two
 * paging granularities the run uses — the web mirror of desktop's
 * `crates/dbboard-core/src/dump/plan.rs` (ADR-0049).
 *
 * Pure. The counting itself is the use case's job; what a count *means* is
 * decided here, so the size policy lives in one place.
 */
import { ROW_CAP } from "../limits";
import type { TableInfo } from "../values/table-info";

/**
 * Total row count above which a dump is refused without an explicit
 * confirmation (ADR-0049 Decision 8, warn-and-allow).
 *
 * Desktop warns in a modal and lets the user proceed. Web has no modal in
 * the request path, so the same policy becomes a preflight gate on the
 * route: over the threshold the request fails naming the count, and the
 * client re-sends with `confirm=true`. Warn-and-allow either way — the
 * difference is only where the "allow" is expressed.
 */
export const DEFAULT_BACKUP_WARN_ROWS = 500_000;

/**
 * Rows read per `SELECT` page.
 *
 * Held under {@link ROW_CAP} deliberately. The cap is enforced by the
 * `ExecuteQuery` use case, which a dump does not go through, so nothing
 * would stop a larger page — but a page bigger than the number the rest of
 * the service treats as "too many rows to hold" is a size nobody could
 * defend. Half of it leaves room for the cap to move without this following.
 */
export const READ_PAGE_ROWS = ROW_CAP / 2;

/**
 * Rows per emitted `INSERT` statement.
 *
 * 500 is SQLite's default compound-statement limit. Web ships no SQLite
 * adapter, so nothing here re-parses on SQLite today — but a dump is a file
 * a human takes elsewhere, and the ceiling costs nothing to respect.
 */
export const INSERT_BATCH_ROWS = 500;

// The paging invariants desktop asserts at compile time. TypeScript cannot
// assert them statically, so plan.spec.ts asserts them instead.

/** One table's contribution to a dump: which table, and how big it is. */
export interface TablePlan {
  table: TableInfo;
  rowCount: number;
}

/** Every table a dump will visit, with its counted size. */
export interface DumpPlan {
  tables: TablePlan[];
}

/** Sum of the per-table counts — what the size gate is measured against. */
export function totalRows(plan: DumpPlan): number {
  return plan.tables.reduce((sum, entry) => sum + entry.rowCount, 0);
}

/**
 * The total when it *exceeds* `threshold`, otherwise `null`. A total exactly
 * at the threshold does not exceed it, matching desktop.
 */
export function exceedsThreshold(
  plan: DumpPlan,
  threshold: number = DEFAULT_BACKUP_WARN_ROWS,
): number | null {
  const total = totalRows(plan);
  return total > threshold ? total : null;
}
