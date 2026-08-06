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
 * Identifier quoting is dialect-aware (ADR-0072), and became so with the
 * MySQL adapter in rung 7. It used to be unconditionally ANSI (`"…"`), which
 * was true while every driver web shipped was Postgres-family or SQLite —
 * but MySQL reads `"orders"` as a *string literal* unless the server runs
 * with ANSI_QUOTES. In `FROM` that is a syntax error; in a `SELECT` list it
 * is worse, because a column reference quietly becomes a constant.
 *
 * ## Two dialects here, three in the API
 *
 * `apps/api/src/domain/dialect.ts` names `sqlite | postgres | mysql`, and
 * this module names `ansi | mysql`. They are deliberately different types.
 * The API's emitters also write *literals*, where SQLite and Postgres part
 * company (`X'…'` versus `'\x…'::bytea`); this module only ever writes
 * identifiers, and there the two agree. Collapsing them into one shared
 * union would import a distinction this side cannot act on and would leave
 * `sqlite` and `postgres` as two names for the same branch.
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
 * How identifiers are quoted: `ansi` is `"…"` (Postgres family, SQLite,
 * libSQL, D1), `mysql` is `` `…` ``.
 */
export type SqlDialect = "ansi" | "mysql";

/**
 * The dialect a driver quotes in.
 *
 * `driver` is `ConnectionView.driver` — a `string`, not a union, because the
 * API can gain a driver without the browser bundle being rebuilt. Anything
 * this build has not heard of, and the `undefined` a component sees while the
 * connection list is still loading, resolve to ANSI: ADR-0072 decision 1.
 *
 * The fallback direction is the safe one and only just. ANSI is what every
 * dialect except MySQL accepts, so guessing it is right for every adapter
 * added after this line — and when it is wrong, it is wrong loudly, as a
 * syntax error the user sees rather than a query against the wrong object.
 * A MySQL-family driver added under a name that is not `mysql` would land
 * here and be wrong; the cost of that is one line in this function.
 */
export function dialectFor(driver: string | null | undefined): SqlDialect {
  return driver === "mysql" ? "mysql" : "ansi";
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
 * Quote an identifier for `dialect`, doubling the embedded quote character
 * so a name can never break out of the quoting.
 *
 * Table and column names come from the database's own catalog, not from
 * user input — but "not user input" is a property of today's callers, not
 * of the string, and a table named `a"b` is legal in Postgres.
 *
 * Only the dialect's *own* quote character is doubled. A `"` inside a
 * back-quoted MySQL identifier is an ordinary character, and doubling it
 * would name a different column rather than escape anything.
 */
export function quoteIdent(name: string, dialect: SqlDialect = "ansi"): string {
  if (dialect === "mysql") return `\`${name.replace(/`/g, "``")}\``;
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a table for use in `FROM`: `"schema"."name"` when schema-qualified,
 * `"name"` otherwise. A `null` schema is what engines without a schema
 * namespace report, and it must produce a bare name — `"".""` and a leading
 * dot are both syntax errors.
 */
export function qualifiedName(table: QualifiedTable, dialect: SqlDialect = "ansi"): string {
  return table.schema
    ? `${quoteIdent(table.schema, dialect)}.${quoteIdent(table.name, dialect)}`
    : quoteIdent(table.name, dialect);
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
export function selectTopN(
  table: QualifiedTable,
  n: number = BROWSE_ROWS,
  dialect: SqlDialect = "ansi",
): string {
  const limit = Math.max(1, Math.floor(n));
  // `LIMIT n` needs no branch: MySQL, SQLite and Postgres all spell it that
  // way. The quoting is the entire dialect difference in this statement.
  return `SELECT * FROM ${qualifiedName(table, dialect)} LIMIT ${limit};`;
}
