/**
 * Classify a `.sql` script into labelled statements — Layer 2 of the restore
 * pipeline (desktop ADR-0051), the web counterpart of
 * `crates/dbboard-core/src/restore/plan.rs`.
 *
 * It takes the raw statements {@link splitStatements} produced and attaches a
 * {@link StatementKind} to each. The label drives two things the runner needs:
 * which statements to **strip** (a dump's own `BEGIN` / `COMMIT` must go,
 * because the runner supplies the transaction boundary itself) and a rough
 * DDL/data breakdown for the confirm dialog and the completion summary.
 *
 * **Downgrade on failure, never fail closed.** A statement this module cannot
 * make sense of is not dropped and not rejected — it is labelled `unparsed`
 * and passed through verbatim for best-effort execution. That is the
 * deliberate inverse of the read-only classifier's stance, and it is what lets
 * ADR-0051's "any `.sql`, not only our own dumps" promise hold: the engine,
 * not this module, has the final say on whether a statement is valid.
 *
 * ## Why this is keywords and not a parser
 *
 * Desktop's Layer 2 is `sqlparser` with a real grammar. Web has no SQL parser
 * and this rung deliberately does not add one, because of what the label is
 * actually for. Four of the five kinds are **informational** — they populate
 * counts a human reads. Exactly one changes behaviour: `transaction_control`,
 * which gets stripped.
 *
 * And `transaction_control` is the one kind a leading-keyword test gets
 * exactly right. `BEGIN`, `START TRANSACTION`, `COMMIT`, `END`, `ROLLBACK`,
 * `SAVEPOINT` and `RELEASE` are leading keywords by grammar; no statement
 * *starts* with `COMMIT` and means something else. The case that looks
 * dangerous — a PL/pgSQL body full of `BEGIN … END` — never reaches here as
 * its own statement, because Layer 1 keeps a dollar-quoted body intact and the
 * statement's leading keyword is `CREATE`.
 *
 * So a misclassification here is cosmetic (a count is slightly off) and never
 * behavioural, with that single exception, which is exact.
 *
 * ## `unparsed` does not mean quite what it means on desktop
 *
 * Desktop's `Unparsed` is "the grammar rejected it". Web's is "the statement
 * does not begin with a keyword we recognise". The two predicates overlap
 * heavily but are not the same, and web's will label as `unparsed` some
 * statements a grammar would happily parse — anything led by a keyword outside
 * {@link OTHER_KEYWORDS}. That is the safe direction: the count is a warning
 * shown to the operator, not a gate, and an over-count reads as "look at this
 * script" rather than as a false all-clear.
 *
 * No dialect parameter, for the reason ADR-0063 gave for `write-back.ts`: web
 * ships the Postgres family only, and these keywords are common to every
 * dialect it will ship. A dialect argument arrives with MySQL, as a parameter
 * on this function rather than as a second copy of it.
 */
import { splitStatements } from "./split";

/**
 * The category a restore statement was classified into.
 *
 * Only `transaction_control` changes behaviour — it is stripped before the
 * runner applies the script. The rest run in file order; `ddl` / `data` /
 * `other` differ only for the summary, and `unparsed` runs verbatim.
 */
export type StatementKind = "ddl" | "data" | "transaction_control" | "other" | "unparsed";

/** One classified statement: its verbatim source text and its kind. */
export interface RestoreStatement {
  sql: string;
  kind: StatementKind;
}

/** Runnable-statement counts, for the confirm dialog and the outcome. */
export interface StatementSummary {
  /** Everything except `transaction_control` — what the runner will execute. */
  runnable: number;
  ddl: number;
  data: number;
  other: number;
  unparsed: number;
}

/**
 * Split `sql` into statements and classify each one.
 *
 * Order is preserved verbatim — restore never reorders, because a dump is
 * already emitted in dependency-safe order and an `INSERT` before its
 * `CREATE TABLE` would fail. A statement this module does not recognise is
 * kept as `unparsed` rather than discarded.
 */
export function classifyScript(sql: string): RestoreStatement[] {
  return splitStatements(sql).map((statement) => ({
    sql: statement,
    kind: classifyOne(statement),
  }));
}

/**
 * The statements the runner will execute: everything except transaction
 * control, in file order. The runner owns the transaction boundary, so a
 * script's own `BEGIN` / `COMMIT` would either nest or commit early.
 */
export function runnableStatements(statements: readonly RestoreStatement[]): RestoreStatement[] {
  return statements.filter((s) => s.kind !== "transaction_control");
}

/** Count the runnable statements by kind. */
export function summarizeStatements(statements: readonly RestoreStatement[]): StatementSummary {
  const summary: StatementSummary = { runnable: 0, ddl: 0, data: 0, other: 0, unparsed: 0 };
  for (const { kind } of statements) {
    if (kind === "transaction_control") continue;
    summary.runnable += 1;
    summary[kind] += 1;
  }
  return summary;
}

function classifyOne(sql: string): StatementKind {
  const keyword = leadingKeyword(sql);
  if (keyword === null) return "unparsed";
  if (TRANSACTION_KEYWORDS.has(keyword)) return "transaction_control";
  if (DATA_KEYWORDS.has(keyword)) return "data";
  if (DDL_KEYWORDS.has(keyword)) return "ddl";
  if (OTHER_KEYWORDS.has(keyword)) return "other";
  return "unparsed";
}

/**
 * The statement's first word, upper-cased — or `null` when the statement does
 * not begin with one.
 *
 * Leading comments and whitespace are skipped: `splitStatements` deliberately
 * leaves a dump's header comment attached to the first statement, so reading
 * the keyword off character zero would classify every dump's opening
 * `CREATE TABLE` as unrecognised.
 */
function leadingKeyword(sql: string): string | null {
  const n = sql.length;
  let i = 0;
  for (;;) {
    while (i < n && /\s/u.test(sql[i] as string)) i += 1;
    if (sql[i] === "-" && sql[i + 1] === "-") {
      i += 2;
      while (i < n && sql[i] !== "\n") i += 1;
      continue;
    }
    if (sql[i] === "/" && sql[i + 1] === "*") {
      i = skipBlockComment(sql, i);
      continue;
    }
    break;
  }
  const start = i;
  while (i < n && /[A-Za-z_]/u.test(sql[i] as string)) i += 1;
  return i > start ? sql.slice(start, i).toUpperCase() : null;
}

/**
 * Skip a nesting-aware block comment. A duplicate of `split.ts`'s scanner
 * rather than a shared export: that one is part of a hot single-pass loop over
 * the whole script and takes its bounds from it, while this one runs once per
 * statement over a handful of leading characters.
 */
function skipBlockComment(sql: string, open: number): number {
  const n = sql.length;
  let depth = 1;
  let i = open + 2;
  while (i < n) {
    if (sql[i] === "/" && sql[i + 1] === "*") {
      depth += 1;
      i += 2;
    } else if (sql[i] === "*" && sql[i + 1] === "/") {
      depth -= 1;
      i += 2;
      if (depth === 0) return i;
    } else {
      i += 1;
    }
  }
  return n;
}

// `END` is here because SQLite spells `COMMIT` that way. It is also the tail
// of a SQLite trigger body — but a trigger body is not dollar-quoted, so
// Layer 1 has already split it at its interior `;` and the fragment is
// unrunnable either way. Desktop's grammar reaches the same verdict
// (`Statement::Commit`), so the mirror is faithful, not merely convenient.
const TRANSACTION_KEYWORDS = new Set([
  "BEGIN",
  "START",
  "COMMIT",
  "END",
  "ROLLBACK",
  "SAVEPOINT",
  "RELEASE",
]);

// `REPLACE` is SQLite's and MySQL's upsert spelling; desktop's grammar folds
// it into `Statement::Insert`, so it counts as data here too.
const DATA_KEYWORDS = new Set(["INSERT", "UPDATE", "DELETE", "COPY", "REPLACE"]);

const DDL_KEYWORDS = new Set(["CREATE", "ALTER", "DROP", "TRUNCATE", "COMMENT"]);

// Recognised, but neither schema nor data. The list is what a dump plausibly
// emits plus the session-level statements that surround one — `pg_dump` opens
// with `SET`, `SELECT pg_catalog.set_config(…)` and `SELECT
// pg_catalog.setval(…)`, and `sqlite3 .dump` with `PRAGMA foreign_keys=OFF`.
// A keyword missing from here is not a bug in the run: it lands in `unparsed`
// and still executes.
const OTHER_KEYWORDS = new Set([
  "SELECT",
  "WITH",
  "VALUES",
  "TABLE",
  "SET",
  "RESET",
  "SHOW",
  "PRAGMA",
  "USE",
  "EXPLAIN",
  "ANALYZE",
  "ANALYSE",
  "VACUUM",
  "REINDEX",
  "CLUSTER",
  "CHECKPOINT",
  "DISCARD",
  "GRANT",
  "REVOKE",
  "CALL",
  "DO",
  "LOCK",
  "UNLOCK",
  "PREPARE",
  "EXECUTE",
  "DEALLOCATE",
  "DECLARE",
  "FETCH",
  "MOVE",
  "CLOSE",
  "LISTEN",
  "UNLISTEN",
  "NOTIFY",
  "REFRESH",
  "REASSIGN",
  "MERGE",
  "ATTACH",
  "DETACH",
  "LOAD",
]);
