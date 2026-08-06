import { describe, expect, it } from "vitest";
import {
  classifyScript,
  runnableStatements,
  summarizeStatements,
  type RestoreStatement,
  type StatementKind,
} from "./plan";

function kinds(sql: string): StatementKind[] {
  return classifyScript(sql).map((s) => s.kind);
}

// Layer 2 of the restore pipeline (desktop ADR-0051). The cases mirror
// desktop's `crates/dbboard-core/src/restore/plan.rs` test module, with the
// `unparsed` cases re-pointed at web's predicate — see the note there:
// desktop's `Unparsed` means "the grammar rejected it", web's means "the
// leading keyword is not one we recognise". Both run verbatim.

describe("classifyScript", () => {
  it("classifies an empty or comment-only script to nothing", () => {
    expect(classifyScript("")).toEqual([]);
    expect(classifyScript("-- just a header\n")).toEqual([]);
  });

  it("labels CREATE TABLE as ddl", () => {
    expect(kinds("CREATE TABLE t (id INTEGER PRIMARY KEY)")).toEqual(["ddl"]);
  });

  it("labels CREATE INDEX and CREATE VIEW as ddl", () => {
    expect(kinds("CREATE INDEX i ON t (a); CREATE VIEW v AS SELECT 1")).toEqual(["ddl", "ddl"]);
  });

  it("labels ALTER, DROP, TRUNCATE and COMMENT as ddl", () => {
    expect(
      kinds("ALTER TABLE t ADD COLUMN b int; DROP TABLE t; TRUNCATE t; COMMENT ON TABLE t IS 'x'"),
    ).toEqual(["ddl", "ddl", "ddl", "ddl"]);
  });

  it("labels INSERT, UPDATE, DELETE and COPY as data", () => {
    expect(
      kinds("INSERT INTO t VALUES (1); UPDATE t SET a = 1; DELETE FROM t; COPY t FROM stdin"),
    ).toEqual(["data", "data", "data", "data"]);
  });

  it("labels transaction control so the runner can strip it", () => {
    expect(
      kinds("BEGIN; START TRANSACTION; SAVEPOINT s; RELEASE SAVEPOINT s; ROLLBACK; COMMIT"),
    ).toEqual([
      "transaction_control",
      "transaction_control",
      "transaction_control",
      "transaction_control",
      "transaction_control",
      "transaction_control",
    ]);
  });

  it("labels a recognised non-DDL, non-data statement as other", () => {
    expect(kinds("SELECT 1; SET statement_timeout = 0; PRAGMA foreign_keys = off")).toEqual([
      "other",
      "other",
      "other",
    ]);
  });

  it("labels a statement whose leading keyword is unrecognised as unparsed, never dropping it", () => {
    const out = classifyScript("FLUMMOX THE DATABASE");
    expect(out).toEqual<RestoreStatement[]>([{ sql: "FLUMMOX THE DATABASE", kind: "unparsed" }]);
  });

  it("labels a statement that does not start with a word as unparsed", () => {
    expect(kinds("(SELECT 1)")).toEqual(["unparsed"]);
  });

  it("reads the leading keyword past comments and whitespace", () => {
    expect(kinds("-- note\n  /* and another */\n  INSERT INTO t VALUES (1)")).toEqual(["data"]);
  });

  it("is case-insensitive on the leading keyword", () => {
    expect(kinds("insert into t values (1); Create Table u (a int)")).toEqual(["data", "ddl"]);
  });

  it("preserves statement text and order verbatim", () => {
    expect(classifyScript("CREATE TABLE t (a int);\nINSERT INTO t VALUES (1)")).toEqual<
      RestoreStatement[]
    >([
      { sql: "CREATE TABLE t (a int)", kind: "ddl" },
      { sql: "INSERT INTO t VALUES (1)", kind: "data" },
    ]);
  });

  it("does not mistake a dollar-quoted BEGIN body for transaction control", () => {
    // Layer 1 keeps the body intact, so the leading keyword is CREATE.
    expect(
      kinds("CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END $$ LANGUAGE plpgsql"),
    ).toEqual(["ddl"]);
  });
});

describe("runnableStatements", () => {
  it("drops transaction control and keeps everything else in order", () => {
    const out = runnableStatements(
      classifyScript("BEGIN; CREATE TABLE t (a int); INSERT INTO t VALUES (1); COMMIT"),
    );
    expect(out.map((s) => s.kind)).toEqual(["ddl", "data"]);
    expect(out[0]?.sql).toBe("CREATE TABLE t (a int)");
  });

  it("keeps unparsed statements — they run best-effort", () => {
    const out = runnableStatements(classifyScript("FLUMMOX; SELECT 1"));
    expect(out.map((s) => s.kind)).toEqual(["unparsed", "other"]);
  });
});

describe("summarizeStatements", () => {
  it("counts runnable statements by kind, excluding transaction control", () => {
    const summary = summarizeStatements(
      classifyScript(
        "BEGIN; CREATE TABLE t (a int); INSERT INTO t VALUES (1); SELECT 1; FLUMMOX; COMMIT",
      ),
    );
    expect(summary).toEqual({ runnable: 4, ddl: 1, data: 1, other: 1, unparsed: 1 });
  });

  it("counts nothing for an empty script", () => {
    expect(summarizeStatements([])).toEqual({
      runnable: 0,
      ddl: 0,
      data: 0,
      other: 0,
      unparsed: 0,
    });
  });
});
