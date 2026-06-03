// A table entry surfaced by `GET /tables`. `schema` is null for engines
// without a schema namespace (SQLite, libSQL, D1). Postgres reports the
// owning schema (typically "public").

export interface TableInfo {
  schema: string | null;
  name: string;
}
