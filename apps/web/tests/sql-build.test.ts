import { describe, expect, it } from "vitest";
import { BROWSE_ROWS, qualifiedName, quoteIdent, selectTopN } from "../app/utils/sql-build";

// These pin the generated text, not just its shape. A browse is the only
// SQL in this app the user did not type, and it is the provenance the cell
// editor keys editability on (ticket 0028) — if the quoting is wrong the
// failure is either a syntax error or, worse, a query against a different
// object than the one clicked.

describe("quoteIdent", () => {
  it("wraps a plain name in double quotes", () => {
    expect(quoteIdent("orders")).toBe('"orders"');
  });

  it("doubles an embedded double quote so a name cannot break out", () => {
    // The whole point of the function. `a"b` unquoted would end the
    // identifier and leave `b"` as stray syntax.
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it("leaves other punctuation alone", () => {
    // A backtick is an ordinary character in an ANSI-quoted identifier.
    // MySQL's quoting arrives with its adapter in rung 7.
    expect(quoteIdent("weird`name")).toBe('"weird`name"');
    expect(quoteIdent("has space")).toBe('"has space"');
  });

  it("quotes an empty name rather than emitting nothing", () => {
    expect(quoteIdent("")).toBe('""');
  });
});

describe("qualifiedName", () => {
  it("qualifies with the schema when there is one", () => {
    expect(qualifiedName({ schema: "public", name: "orders" })).toBe('"public"."orders"');
  });

  it("omits the schema when there is none", () => {
    // `null` is what engines without a schema namespace report. `"".""` or
    // a leading dot would both be syntax errors.
    expect(qualifiedName({ schema: null, name: "orders" })).toBe('"orders"');
  });

  it("quotes both halves independently", () => {
    expect(qualifiedName({ schema: 'a"b', name: 'c"d' })).toBe('"a""b"."c""d"');
  });
});

describe("selectTopN", () => {
  it("builds a bounded SELECT * for a qualified table", () => {
    expect(selectTopN({ schema: "public", name: "orders" }, 100)).toBe(
      'SELECT * FROM "public"."orders" LIMIT 100;',
    );
  });

  it("selects every column, because the editor needs the key columns", () => {
    // Not a stylistic choice: `buildRowUpdates` refuses when a primary-key
    // column is absent from the result, so a projected browse would render
    // a grid that looks editable and fails on Save.
    expect(selectTopN({ schema: null, name: "t" }, 1)).toContain("SELECT * ");
  });

  it("floors the limit to a positive integer", () => {
    // A non-integer or non-positive limit would be a syntax error or an
    // empty grid. Clamp rather than throw: the caller is a menu, not input.
    expect(selectTopN({ schema: null, name: "t" }, 2.7)).toBe('SELECT * FROM "t" LIMIT 2;');
    expect(selectTopN({ schema: null, name: "t" }, 0)).toBe('SELECT * FROM "t" LIMIT 1;');
    expect(selectTopN({ schema: null, name: "t" }, -5)).toBe('SELECT * FROM "t" LIMIT 1;');
  });

  it("defaults to the browse row count", () => {
    expect(selectTopN({ schema: null, name: "t" })).toBe(`SELECT * FROM "t" LIMIT ${BROWSE_ROWS};`);
  });
});

describe("BROWSE_ROWS", () => {
  it("stays well under the API's 10,000-row cap", () => {
    // A browse that tripped the cap would fail before it could be edited.
    expect(BROWSE_ROWS).toBeLessThan(10_000);
    expect(BROWSE_ROWS).toBeGreaterThan(0);
  });
});
