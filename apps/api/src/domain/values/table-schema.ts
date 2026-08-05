import type { TableInfo } from "./table-info";

// Introspection types, mirroring desktop ADR-0028 (`describe_table`).
//
// `ColumnInfo` is deliberately NOT `Column`. `Column` describes a column of
// a *result set* — it is on the wire in `QueryResult` and pinned by
// `docs/api-contract.md`, and a result set has no primary key or default to
// report. Desktop keeps the same split (`Column` in row.rs, `ColumnInfo` in
// schema.rs); widening the shared one here would break the byte-mirror.
export interface ColumnInfo {
  name: string;
  // Engine-reported type text (`integer`, `character varying`, …). Null when
  // the engine reports none, matching `Column.declared_type`.
  declared_type: string | null;
  nullable: boolean;
  primary_key: boolean;
  // 1-based position within the table, so the UI can render columns in DDL
  // order without relying on array order surviving serialization. Postgres'
  // `information_schema.columns.ordinal_position` is already 1-based;
  // engines that count from zero (SQLite's `PRAGMA table_info.cid`) are
  // normalized by their adapter.
  ordinal: number;
  // Raw DDL default expression exactly as the engine reports it, e.g.
  // `nextval('users_id_seq'::regclass)`. Null when there is no default.
  // Never parsed into a typed value: sequence calls and engine-specific
  // expressions have no faithful typed representation.
  default_value: string | null;
}

export interface TableSchema {
  table: TableInfo;
  columns: ColumnInfo[];
  // Primary-key column names in key order — the order matters for composite
  // keys and is lost if a reader derives it by filtering `columns`. Empty
  // when the table has no primary key. Adapters keep this in agreement with
  // the per-column `primary_key` flags; readers may trust either.
  primary_key: string[];
}
