import { describe, expect, it } from "vitest";
import {
  BROWSE_ROWS,
  dialectFor,
  qualifiedName,
  quoteIdent,
  selectTopN,
} from "../app/utils/sql-build";

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
    // A backtick is an ordinary character in an ANSI-quoted identifier, and
    // stays one — the MySQL dialect doubles it, this one must not.
    expect(quoteIdent("weird`name")).toBe('"weird`name"');
    expect(quoteIdent("has space")).toBe('"has space"');
  });

  it("quotes an empty name rather than emitting nothing", () => {
    expect(quoteIdent("")).toBe('""');
  });

  it("back-quotes in the mysql dialect", () => {
    // Not a preference. MySQL reads `"orders"` as a *string literal* unless
    // the server runs with ANSI_QUOTES, so ANSI quoting there is a syntax
    // error in `FROM` — and in a `SELECT` list it is worse: a column
    // reference silently becomes a constant string.
    expect(quoteIdent("orders", "mysql")).toBe("`orders`");
  });

  it("doubles only its own quote character, per dialect", () => {
    // The asymmetry that makes this two functions' worth of care. A `"`
    // inside a back-quoted identifier is an ordinary character, and
    // doubling it would rename the column.
    expect(quoteIdent("a`b", "mysql")).toBe("`a``b`");
    expect(quoteIdent('a"b', "mysql")).toBe('`a"b`');
    expect(quoteIdent("a`b", "ansi")).toBe('"a`b"');
  });
});

describe("dialectFor", () => {
  it("answers mysql for the mysql driver", () => {
    expect(dialectFor("mysql")).toBe("mysql");
  });

  it("answers ansi for every other driver web ships", () => {
    expect(dialectFor("postgres")).toBe("ansi");
    expect(dialectFor("turso")).toBe("ansi");
    expect(dialectFor("d1")).toBe("ansi");
    expect(dialectFor("null")).toBe("ansi");
  });

  it("falls back to ansi for a driver this build has never heard of", () => {
    // ADR-0072 decision 1, and the direction matters: ANSI is what every
    // dialect except MySQL accepts, so it is the right guess for an adapter
    // the API gained after this bundle was built. The browser is in no
    // position to refuse a driver name the server accepted.
    expect(dialectFor("cockroach")).toBe("ansi");
    expect(dialectFor("")).toBe("ansi");
  });

  it("falls back to ansi before a connection is known", () => {
    // The schema browser renders while the connection list is still
    // loading, so `undefined` is a real state and not a defensive branch.
    expect(dialectFor(undefined)).toBe("ansi");
    expect(dialectFor(null)).toBe("ansi");
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

  it("carries the dialect into both halves", () => {
    expect(qualifiedName({ schema: "shop", name: "orders" }, "mysql")).toBe("`shop`.`orders`");
    expect(qualifiedName({ schema: null, name: "orders" }, "mysql")).toBe("`orders`");
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

  it("builds a MySQL browse that MySQL can actually run", () => {
    // `LIMIT n` needs no dialect branch — MySQL, SQLite and Postgres all
    // spell it the same way. The quoting is the whole difference, which is
    // why the dialect stops at `qualifiedName`.
    expect(selectTopN({ schema: "shop", name: "orders" }, 100, "mysql")).toBe(
      "SELECT * FROM `shop`.`orders` LIMIT 100;",
    );
  });
});

describe("BROWSE_ROWS", () => {
  it("stays well under the API's 10,000-row cap", () => {
    // A browse that tripped the cap would fail before it could be edited.
    expect(BROWSE_ROWS).toBeLessThan(10_000);
    expect(BROWSE_ROWS).toBeGreaterThan(0);
  });
});
