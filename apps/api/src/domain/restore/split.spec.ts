import { describe, expect, it } from "vitest";
import { splitStatements } from "./split";

// Layer 1 of the restore pipeline (desktop ADR-0051). Every case here maps
// to a case in desktop's `crates/dbboard-core/src/restore/split.rs` test
// module — this is a lexical scanner whose correctness is entirely in the
// edge cases, so the mirror is asserted case for case rather than by shape.

describe("splitStatements", () => {
  it("yields no statements for empty or blank input", () => {
    expect(splitStatements("")).toEqual([]);
    expect(splitStatements("   \n\t ")).toEqual([]);
  });

  it("splits two simple statements", () => {
    expect(splitStatements("SELECT 1; SELECT 2;")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("returns a trailing statement without a semicolon", () => {
    expect(splitStatements("SELECT 1;\nSELECT 2")).toEqual(["SELECT 1", "SELECT 2"]);
  });

  it("does not split on a semicolon inside a string literal", () => {
    expect(splitStatements("INSERT INTO t VALUES ('a; b'); SELECT 1")).toEqual([
      "INSERT INTO t VALUES ('a; b')",
      "SELECT 1",
    ]);
  });

  it("treats a doubled quote as an escape within a string", () => {
    expect(splitStatements("INSERT INTO t VALUES ('O''Brien; Jr'); SELECT 1")).toEqual([
      "INSERT INTO t VALUES ('O''Brien; Jr')",
      "SELECT 1",
    ]);
  });

  it("treats a backslash as literal in a standard string", () => {
    // `'a\'` is the complete two-character string `a\`, so the following
    // `;` splits. Honouring backslash everywhere would swallow it.
    expect(splitStatements("SELECT 'a\\'; SELECT 2")).toEqual(["SELECT 'a\\'", "SELECT 2"]);
  });

  it("honours a backslash escape only in an escape string", () => {
    // `E'\''` is a one-character string containing a quote; the `;` after
    // it splits, and the backslash-escaped quote must not close it.
    expect(splitStatements("SELECT E'\\''; SELECT 2")).toEqual(["SELECT E'\\''", "SELECT 2"]);
  });

  it("does not read a trailing `e` of an identifier as an escape-string opener", () => {
    // `type` ends in `e`, but the `'…'` after it is a standard string: the
    // interior `\'` closes it, and the `;` splits.
    expect(splitStatements("SELECT type '\\'; SELECT 2")).toEqual(["SELECT type '\\'", "SELECT 2"]);
  });

  it("does not split on a semicolon inside a quoted identifier", () => {
    expect(splitStatements('SELECT "a;b" FROM t; SELECT 1')).toEqual([
      'SELECT "a;b" FROM t',
      "SELECT 1",
    ]);
  });

  it("does not split on a semicolon inside a back-tick identifier", () => {
    expect(splitStatements("SELECT `a;b` FROM t; SELECT 1")).toEqual([
      "SELECT `a;b` FROM t",
      "SELECT 1",
    ]);
  });

  it("does not split on a semicolon inside a dollar-quoted body", () => {
    const out = splitStatements(
      "CREATE FUNCTION f() RETURNS int AS $$ BEGIN; RETURN 1; END; $$ LANGUAGE plpgsql; SELECT 1",
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("BEGIN; RETURN 1; END;");
    expect(out[1]).toBe("SELECT 1");
  });

  it("matches a tagged dollar quote only against its own tag", () => {
    // A bare `$$` inside a `$body$…$body$` region must not close it.
    const out = splitStatements("SELECT $body$ a $$ b ; c $body$; SELECT 1");
    expect(out).toHaveLength(2);
    expect(out[0]).toContain("$$ b ; c");
    expect(out[1]).toBe("SELECT 1");
  });

  it("does not read a dollar parameter placeholder as a dollar quote", () => {
    expect(splitStatements("SELECT $1 FROM t WHERE id = $2; SELECT 1")).toEqual([
      "SELECT $1 FROM t WHERE id = $2",
      "SELECT 1",
    ]);
  });

  it("does not split on a semicolon inside a line comment", () => {
    const out = splitStatements("SELECT 1 -- a; b\n; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[0]?.startsWith("SELECT 1")).toBe(true);
    expect(out[1]).toBe("SELECT 2");
  });

  it("does not split on a semicolon inside a block comment", () => {
    const out = splitStatements("SELECT 1 /* a; b */; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("SELECT 2");
  });

  it("balances nested block comments", () => {
    const out = splitStatements("SELECT 1 /* outer /* inner; */ still; */; SELECT 2");
    expect(out).toHaveLength(2);
    expect(out[1]).toBe("SELECT 2");
  });

  it("drops comment-only and blank segments", () => {
    expect(splitStatements("-- a dump header\n\n; ; SELECT 1; -- trailing\n")).toEqual([
      "SELECT 1",
    ]);
  });

  it("preserves interior comments in the statement", () => {
    expect(splitStatements("-- note\nSELECT 1")).toEqual(["-- note\nSELECT 1"]);
  });

  it("consumes an unterminated string to end of input without throwing", () => {
    expect(splitStatements("SELECT 'oops; no close")).toEqual(["SELECT 'oops; no close"]);
  });

  it("splits a realistic pg_dump snippet into its statements", () => {
    const src = [
      "-- dbboard logical dump (postgres)",
      "",
      "CREATE TABLE public.users (",
      "    id integer NOT NULL,",
      "    note text",
      ");",
      "",
      "INSERT INTO public.users VALUES (1, 'has ; and '' quote');",
      "INSERT INTO public.users VALUES (2, E'tab\\tafter; semicolon');",
      "",
      "CREATE FUNCTION public.greet() RETURNS text AS $func$",
      "BEGIN",
      "    RETURN 'hi; there';",
      "END;",
      "$func$ LANGUAGE plpgsql;",
      "",
    ].join("\n");
    const out = splitStatements(src);
    expect(out).toHaveLength(4);
    // The dump header comment leads the first statement (there is no `;`
    // between them), so it rides along — harmless to execute, and pinned
    // here as the documented leading-comment behaviour.
    expect(out[0]).toContain("CREATE TABLE public.users");
    expect(out[1]).toContain("has ; and '' quote");
    expect(out[2]).toContain("tab\\tafter; semicolon");
    expect(out[3]).toContain("$func$");
    expect(out[3]).toContain("RETURN 'hi; there';");
  });
});
