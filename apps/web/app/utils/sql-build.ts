/**
 * Pure SQL-text builders for the "generate a query for me" affordances —
 * today the schema browser's browse action (ticket 0028 slice A).
 *
 * This is the one place in the web client that produces SQL the user did
 * not type, so it is a module with tests rather than a template literal in
 * a click handler. Desktop draws the same line: browse SQL is built in the
 * frontend (`src/lib/sql/build.ts`), the write-back `UPDATE` is built in
 * core — the difference being that only one of them is a write.
 *
 * Identifier quoting is ANSI (`"…"`), which every engine web ships accepts.
 * It is deliberately not parameterised by dialect yet: MySQL reads
 * `"orders"` as a *string literal* unless the server runs with ANSI_QUOTES,
 * so `SELECT * FROM "shop"."orders"` is a syntax error there rather than a
 * subtly wrong result. That branch arrives with the MySQL adapter and
 * ADR-0072 in rung 7, and it belongs to the same function then.
 */

/**
 * A table this module can name: everything it needs and nothing else.
 *
 * Structural rather than an import of `useSchemaBrowser`'s `TableInfo`,
 * which is the same shape — that composable calls into here, and a type
 * import back would make the cycle real the moment someone widened it to a
 * value import.
 */
export interface QualifiedTable {
  schema: string | null;
  name: string;
}

/**
 * Rows a browse fetches.
 *
 * Matches desktop's `BROWSE_ROWS`. Two ceilings sit above it and neither is
 * close: the API refuses a result over 10,000 rows, and the grid renders
 * every row it is given. A hundred is enough to recognise a table by and
 * small enough to edit in.
 */
export const BROWSE_ROWS = 100;

/**
 * Quote an identifier, doubling the embedded quote character so a name can
 * never break out of the quoting.
 *
 * Table and column names come from the database's own catalog, not from
 * user input — but "not user input" is a property of today's callers, not
 * of the string, and a table named `a"b` is legal in Postgres.
 */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a table for use in `FROM`: `"schema"."name"` when schema-qualified,
 * `"name"` otherwise. A `null` schema is what engines without a schema
 * namespace report, and it must produce a bare name — `"".""` and a leading
 * dot are both syntax errors.
 */
export function qualifiedName(table: QualifiedTable): string {
  return table.schema
    ? `${quoteIdent(table.schema)}.${quoteIdent(table.name)}`
    : quoteIdent(table.name);
}

/**
 * A bounded `SELECT *` for `table`.
 *
 * Every column, not a projection: the cell editor keys each row's `UPDATE`
 * on the declared primary key, and `buildRowUpdates` refuses when a key
 * column is absent from the result. A projected browse would render a grid
 * that looks editable and fails on Save.
 *
 * `n` is floored to a positive integer so the generated SQL is always
 * well-formed. Clamping rather than throwing is right here because the
 * caller is a menu, not a text box.
 */
export function selectTopN(table: QualifiedTable, n: number = BROWSE_ROWS): string {
  const limit = Math.max(1, Math.floor(n));
  return `SELECT * FROM ${qualifiedName(table)} LIMIT ${limit};`;
}
