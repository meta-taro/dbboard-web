import type { Column } from "./column";
import type { Value } from "./value";

// `rows` is an array of arrays: one inner array per row, positional,
// aligned with `columns`. `rows_affected` is informational on SELECT
// (often 0) and load-bearing on DML.

export interface QueryResult {
  columns: Column[];
  rows: Value[][];
  rows_affected: number;
}
