import { describe, expect, it } from "vitest";
import {
  buildUpdateSql,
  resolveRowIdentity,
  qualifiedTable,
  quoteIdent,
  quoteLiteral,
  WriteBackError,
  WriteBackErrorKind,
  type UpdatePlan,
} from "./write-back";

// Escaping is the part of the write-back path that is unsafe to re-derive,
// so these tests pin emitted text rather than shape. Every case here maps to
// a case in desktop's `write_back.rs` test module (ADR-0042 / ADR-0063), and
// the dialect cases to the ones ADR-0068 and ADR-0072 added there.

describe("quoteIdent", () => {
  it("wraps a plain identifier in double quotes on the ANSI dialects", () => {
    expect(quoteIdent("email", "postgres")).toBe('"email"');
    expect(quoteIdent("email", "sqlite")).toBe('"email"');
  });

  it("wraps a plain identifier in back-ticks on MySQL", () => {
    // Without `ANSI_QUOTES` set, MySQL reads `"email"` as a string literal —
    // so the ANSI form is not merely unidiomatic there, it selects a constant.
    expect(quoteIdent("email", "mysql")).toBe("`email`");
  });

  it("doubles an embedded double quote on the ANSI dialects", () => {
    // Without this, a column named `a"b` would end the identifier and leave
    // the rest of the name as stray syntax — or worse, as executable text.
    expect(quoteIdent('a"b', "postgres")).toBe('"a""b"');
    expect(quoteIdent('a"b', "sqlite")).toBe('"a""b"');
  });

  it("doubles an embedded back-tick on MySQL", () => {
    expect(quoteIdent("a`b", "mysql")).toBe("`a``b`");
  });

  it("escapes only its own delimiter", () => {
    // ADR-0072 decision 2. A `"` inside a back-quoted MySQL identifier is an
    // ordinary character; doubling it there would rename the column. The
    // mirror holds on the ANSI side for a back-tick.
    expect(quoteIdent('a"b', "mysql")).toBe('`a"b`');
    expect(quoteIdent("a`b", "postgres")).toBe('"a`b"');
  });

  it("leaves a single quote alone inside an identifier", () => {
    // Identifier quoting and literal quoting escape different characters.
    // Doubling `'` here would corrupt the name.
    expect(quoteIdent("o'brien", "postgres")).toBe('"o\'brien"');
    expect(quoteIdent("o'brien", "mysql")).toBe("`o'brien`");
  });
});

describe("quoteLiteral", () => {
  it("wraps text in single quotes", () => {
    expect(quoteLiteral("hello", "postgres")).toBe("'hello'");
    expect(quoteLiteral("hello", "mysql")).toBe("'hello'");
  });

  it("doubles an embedded single quote on every dialect", () => {
    expect(quoteLiteral("O'Brien", "postgres")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "sqlite")).toBe("'O''Brien'");
    expect(quoteLiteral("O'Brien", "mysql")).toBe("'O''Brien'");
  });

  it("does not touch a backslash on the ANSI dialects", () => {
    // Postgres treats a backslash as an ordinary character in a standard
    // string literal (standard_conforming_strings has been on by default
    // since 9.1), and so does SQLite. Doubling it there would store two.
    expect(quoteLiteral("a\\b", "postgres")).toBe("'a\\b'");
    expect(quoteLiteral("a\\b", "sqlite")).toBe("'a\\b'");
  });

  it("doubles a backslash on MySQL", () => {
    // MySQL reads `\` as an escape character unless the server runs with
    // `NO_BACKSLASH_ESCAPES`, so `a\b` would arrive as a backspace.
    expect(quoteLiteral("a\\b", "mysql")).toBe("'a\\\\b'");
  });

  it("escapes the backslash before the quote on MySQL, not after", () => {
    // ADR-0068 decision 1, and the reason the order is pinned by a test: if
    // the quote pass ran first, this input's `''` would then have its own
    // added characters re-escaped and the literal would break out.
    expect(quoteLiteral("a\\b'c", "mysql")).toBe("'a\\\\b''c'");
  });

  it("emits an empty string as a quoted empty literal, not NULL", () => {
    // The one place where "" and NULL must not be conflated: the editor
    // offers an explicit NULL affordance precisely so the user can say which.
    expect(quoteLiteral("", "postgres")).toBe("''");
  });
});

describe("qualifiedTable", () => {
  it("qualifies with the schema when there is one", () => {
    expect(qualifiedTable({ schema: "public", name: "users" }, "postgres")).toBe(
      '"public"."users"',
    );
    expect(qualifiedTable({ schema: "shop", name: "users" }, "mysql")).toBe("`shop`.`users`");
  });

  it("omits the schema when there is none", () => {
    expect(qualifiedTable({ schema: null, name: "users" }, "postgres")).toBe('"users"');
  });

  it("drops the schema on SQLite even when one is present", () => {
    // SQLite has no schema namespace. Both SQLite-wire adapters report
    // `schema: null` from `listTables`, so this should not arise — but a
    // qualified name there is a syntax error, and the guard costs nothing.
    expect(qualifiedTable({ schema: "main", name: "users" }, "sqlite")).toBe('"users"');
  });

  it("quotes both halves independently", () => {
    expect(qualifiedTable({ schema: 'a"b', name: 'c"d' }, "postgres")).toBe('"a""b"."c""d"');
  });
});

describe("buildUpdateSql", () => {
  const base: UpdatePlan = {
    table: { schema: "public", name: "users" },
    key: [{ column: "id", value: 7 }],
    edits: [{ column: "email", value: { kind: "text", text: "new@example.com" } }],
  };

  it("builds a single-row UPDATE", () => {
    expect(buildUpdateSql(base, "postgres")).toBe(
      `UPDATE "public"."users" SET "email" = 'new@example.com' WHERE "id" = 7`,
    );
  });

  it("builds the same UPDATE in MySQL syntax", () => {
    // The whole statement, not one clause: the dialect has to reach the
    // table name, the SET identifiers and the WHERE identifiers alike. A
    // seam threaded into three of the four places is still broken.
    expect(buildUpdateSql(base, "mysql")).toBe(
      "UPDATE `public`.`users` SET `email` = 'new@example.com' WHERE `id` = 7",
    );
  });

  it("builds it unqualified on SQLite", () => {
    expect(buildUpdateSql(base, "sqlite")).toBe(
      `UPDATE "users" SET "email" = 'new@example.com' WHERE "id" = 7`,
    );
  });

  it("preserves edit order in the SET clause", () => {
    // Deterministic output: stable tests, and a readable history entry.
    const sql = buildUpdateSql(
      {
        ...base,
        edits: [
          { column: "b", value: { kind: "text", text: "2" } },
          { column: "a", value: { kind: "text", text: "1" } },
        ],
      },
      "postgres",
    );
    expect(sql).toContain(`SET "b" = '2', "a" = '1' WHERE`);
  });

  it("emits an explicit NULL as the bare keyword", () => {
    const sql = buildUpdateSql(
      { ...base, edits: [{ column: "email", value: { kind: "null" } }] },
      "postgres",
    );
    expect(sql).toContain(`SET "email" = NULL WHERE`);
  });

  it("emits an empty edit as '' rather than NULL", () => {
    const sql = buildUpdateSql(
      { ...base, edits: [{ column: "email", value: { kind: "text", text: "" } }] },
      "postgres",
    );
    expect(sql).toContain(`SET "email" = '' WHERE`);
  });

  it("escapes quotes in both the identifier and the value", () => {
    const sql = buildUpdateSql(
      {
        table: { schema: null, name: 'we"ird' },
        key: [{ column: "id", value: 1 }],
        edits: [{ column: 'a"b', value: { kind: "text", text: "it's" } }],
      },
      "postgres",
    );
    expect(sql).toBe(`UPDATE "we""ird" SET "a""b" = 'it''s' WHERE "id" = 1`);
  });

  it("escapes a MySQL edit by MySQL's rules, delimiter and backslash both", () => {
    const sql = buildUpdateSql(
      {
        table: { schema: null, name: "we`ird" },
        key: [{ column: "id", value: 1 }],
        edits: [{ column: "a`b", value: { kind: "text", text: "c:\\it's" } }],
      },
      "mysql",
    );
    expect(sql).toBe("UPDATE `we``ird` SET `a``b` = 'c:\\\\it''s' WHERE `id` = 1");
  });

  it("writes every staged value as a string literal, whatever it looks like", () => {
    // The editor produces text and only text. The engine coerces it by the
    // target column's type (Postgres assignment cast from an `unknown`
    // literal), so a numeric-looking edit still goes out quoted — guessing
    // its type here would be the client overriding the column's.
    const sql = buildUpdateSql(
      { ...base, edits: [{ column: "age", value: { kind: "text", text: "42" } }] },
      "postgres",
    );
    expect(sql).toContain(`SET "age" = '42' WHERE`);
  });

  describe("the WHERE key", () => {
    it("encodes a numeric identity value bare", () => {
      // Typed from the row, not round-tripped through text: `= 7` matches an
      // integer key, `= '7'` would need a cast Postgres will not always make.
      expect(buildUpdateSql({ ...base, key: [{ column: "id", value: 7 }] }, "postgres")).toContain(
        `WHERE "id" = 7`,
      );
    });

    it("encodes a text identity value as a quoted literal, escaped", () => {
      expect(
        buildUpdateSql({ ...base, key: [{ column: "sku", value: "a'b" }] }, "postgres"),
      ).toContain(`WHERE "sku" = 'a''b'`);
    });

    it("escapes a text identity value by the dialect's rules too", () => {
      // The `WHERE` half is where a mis-escape stops being a syntax error and
      // starts matching the wrong row, so the dialect has to reach it.
      expect(
        buildUpdateSql({ ...base, key: [{ column: "sku", value: "a\\b" }] }, "mysql"),
      ).toContain("WHERE `sku` = 'a\\\\b'");
    });

    it("encodes a null identity value as IS NULL", () => {
      // `= NULL` is never true. A primary key is never null, but the
      // predicate has to be correct for the unique-key fallback this shape
      // leaves room for.
      expect(
        buildUpdateSql({ ...base, key: [{ column: "opt", value: null }] }, "postgres"),
      ).toContain(`WHERE "opt" IS NULL`);
    });

    it("joins a composite key with AND, in key order", () => {
      const sql = buildUpdateSql(
        {
          ...base,
          key: [
            { column: "tenant", value: "acme" },
            { column: "id", value: 3 },
          ],
        },
        "postgres",
      );
      expect(sql).toContain(`WHERE "tenant" = 'acme' AND "id" = 3`);
    });
  });

  describe("refusals", () => {
    it("refuses when nothing was edited", () => {
      // An UPDATE with an empty SET is a syntax error; more to the point,
      // there is nothing to write.
      expect(() => buildUpdateSql({ ...base, edits: [] }, "postgres")).toThrowError(WriteBackError);
      try {
        buildUpdateSql({ ...base, edits: [] }, "postgres");
      } catch (err) {
        expect((err as WriteBackError).kind).toBe(WriteBackErrorKind.NoEdits);
      }
    });

    it("refuses an unkeyed update rather than rewriting the table", () => {
      // The single most damaging thing this module could emit is an UPDATE
      // with no WHERE. It is a throw, not a fallback.
      expect(() => buildUpdateSql({ ...base, key: [] }, "postgres")).toThrowError(WriteBackError);
      try {
        buildUpdateSql({ ...base, key: [] }, "postgres");
      } catch (err) {
        expect((err as WriteBackError).kind).toBe(WriteBackErrorKind.EmptyKey);
      }
    });

    it("refuses a blob identity value, naming the column", () => {
      // A blob has no safe literal form for a WHERE comparison. Encoding it
      // as its base64 text would compare against the wrong thing and could
      // match a different row.
      try {
        buildUpdateSql(
          { ...base, key: [{ column: "digest", value: { $blob: "AAEC" } }] },
          "postgres",
        );
        expect.unreachable("expected a refusal");
      } catch (err) {
        expect((err as WriteBackError).kind).toBe(WriteBackErrorKind.UnsupportedKeyType);
        expect((err as WriteBackError).message).toContain("digest");
      }
    });

    it("refuses a blob identity value on every dialect", () => {
      // MySQL has `X'…'` and so does SQLite, so a blob key is *expressible*
      // there — but the refusal is not about syntax. The browse grid renders
      // a blob as a preview, and comparing against the preview would match
      // the wrong row. Desktop refuses on all three for the same reason.
      for (const dialect of ["sqlite", "mysql"] as const) {
        expect(() =>
          buildUpdateSql(
            { ...base, key: [{ column: "digest", value: { $blob: "AAEC" } }] },
            dialect,
          ),
        ).toThrowError(WriteBackError);
      }
    });

    it("refuses a document identity value, naming the column and the type", () => {
      // `$json` is a well-formed `Value` as of the contract version that
      // added it, so it cannot fall through to the "unreachable" arm — that
      // message says nothing a caller can act on. Postgres `json` has no
      // equality operator at all, and where an engine does compare documents
      // it does so by a normalisation this module does not perform, so the
      // predicate would silently match the wrong row or none.
      for (const dialect of ["postgres", "sqlite", "mysql"] as const) {
        try {
          buildUpdateSql(
            { ...base, key: [{ column: "doc", value: { $json: { a: 1 } } }] },
            dialect,
          );
          expect.unreachable("expected a refusal");
        } catch (err) {
          expect((err as WriteBackError).kind).toBe(WriteBackErrorKind.UnsupportedKeyType);
          expect((err as WriteBackError).message).toContain("doc");
          expect((err as WriteBackError).message).toContain("document");
        }
      }
    });
  });

  it("never emits an UPDATE without a WHERE", () => {
    // A property, not an example: whatever it returns, it is keyed.
    const sql = buildUpdateSql(base, "postgres");
    expect(sql).toMatch(/ WHERE /);
  });
});

describe("resolveRowIdentity", () => {
  const column = (name: string, primary_key: boolean) => ({
    name,
    declared_type: "text",
    nullable: !primary_key,
    primary_key,
    ordinal: 1,
    default_value: null,
  });

  it("returns the declared primary key, in key order", () => {
    // Key order is load-bearing for a composite key and is lost if a reader
    // derives it by filtering `columns` — so it comes from `primary_key`.
    expect(
      resolveRowIdentity({
        table: { schema: "public", name: "t" },
        columns: [column("b", true), column("a", true)],
        primary_key: ["a", "b"],
      }),
    ).toEqual(["a", "b"]);
  });

  it("refuses a table with no primary key", () => {
    // Postgres has no safe implicit row key — `ctid` is not stable across a
    // vacuum — so an unkeyed table is not editable. Desktop's SQLite `rowid`
    // path is not ported (ADR-0063 decision 2 dropped it), and the browse
    // query could not key on it anyway: `SELECT *` does not return `rowid`.
    expect(
      resolveRowIdentity({
        table: { schema: "public", name: "t" },
        columns: [column("a", false)],
        primary_key: [],
      }),
    ).toBeNull();
  });

  it("does not fall back to the per-column flags", () => {
    // The two agree in practice, but `primary_key` is the ordered one. A
    // fallback would silently produce a key in column order, which is a
    // different key for a composite PK.
    expect(
      resolveRowIdentity({
        table: { schema: null, name: "t" },
        columns: [column("a", true)],
        primary_key: [],
      }),
    ).toBeNull();
  });
});
