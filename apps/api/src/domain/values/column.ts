// A column descriptor in a QueryResult. `declared_type` is null when the
// adapter reports no type (SQLite expression columns, D1 /raw results).

export interface Column {
  name: string;
  declared_type: string | null;
}
