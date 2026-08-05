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
// a case in desktop's `write_back.rs` test module (ADR-0042 / ADR-0063).

describe("quoteIdent", () => {
  it("wraps a plain identifier in double quotes", () => {
    expect(quoteIdent("email")).toBe('"email"');
  });

  it("doubles an embedded double quote", () => {
    // Without this, a column named `a"b` would end the identifier and leave
    // the rest of the name as stray syntax — or worse, as executable text.
    expect(quoteIdent('a"b')).toBe('"a""b"');
  });

  it("leaves a single quote alone inside an identifier", () => {
    // Identifier quoting and literal quoting escape different characters.
    // Doubling `'` here would corrupt the name.
    expect(quoteIdent("o'brien")).toBe('"o\'brien"');
  });
});

describe("quoteLiteral", () => {
  it("wraps text in single quotes", () => {
    expect(quoteLiteral("hello")).toBe("'hello'");
  });

  it("doubles an embedded single quote", () => {
    expect(quoteLiteral("O'Brien")).toBe("'O''Brien'");
  });

  it("does not touch a backslash", () => {
    // Postgres treats a backslash as an ordinary character in a standard
    // string literal (standard_conforming_strings has been on by default
    // since 9.1). Doubling it here would store two backslashes. MySQL is
    // the dialect that needs it, and it arrives with ADR-0068 in rung 7.
    expect(quoteLiteral("a\\b")).toBe("'a\\b'");
  });

  it("emits an empty string as a quoted empty literal, not NULL", () => {
    // The one place where "" and NULL must not be conflated: the editor
    // offers an explicit NULL affordance precisely so the user can say which.
    expect(quoteLiteral("")).toBe("''");
  });
});

describe("qualifiedTable", () => {
  it("qualifies with the schema when there is one", () => {
    expect(qualifiedTable({ schema: "public", name: "users" })).toBe('"public"."users"');
  });

  it("omits the schema when there is none", () => {
    expect(qualifiedTable({ schema: null, name: "users" })).toBe('"users"');
  });

  it("quotes both halves independently", () => {
    expect(qualifiedTable({ schema: 'a"b', name: 'c"d' })).toBe('"a""b"."c""d"');
  });
});

describe("buildUpdateSql", () => {
  const base: UpdatePlan = {
    table: { schema: "public", name: "users" },
    key: [{ column: "id", value: 7 }],
    edits: [{ column: "email", value: { kind: "text", text: "new@example.com" } }],
  };

  it("builds a single-row UPDATE", () => {
    expect(buildUpdateSql(base)).toBe(
      `UPDATE "public"."users" SET "email" = 'new@example.com' WHERE "id" = 7`,
    );
  });

  it("preserves edit order in the SET clause", () => {
    // Deterministic output: stable tests, and a readable history entry.
    const sql = buildUpdateSql({
      ...base,
      edits: [
        { column: "b", value: { kind: "text", text: "2" } },
        { column: "a", value: { kind: "text", text: "1" } },
      ],
    });
    expect(sql).toContain(`SET "b" = '2', "a" = '1' WHERE`);
  });

  it("emits an explicit NULL as the bare keyword", () => {
    const sql = buildUpdateSql({
      ...base,
      edits: [{ column: "email", value: { kind: "null" } }],
    });
    expect(sql).toContain(`SET "email" = NULL WHERE`);
  });

  it("emits an empty edit as '' rather than NULL", () => {
    const sql = buildUpdateSql({
      ...base,
      edits: [{ column: "email", value: { kind: "text", text: "" } }],
    });
    expect(sql).toContain(`SET "email" = '' WHERE`);
  });

  it("escapes quotes in both the identifier and the value", () => {
    const sql = buildUpdateSql({
      table: { schema: null, name: 'we"ird' },
      key: [{ column: "id", value: 1 }],
      edits: [{ column: 'a"b', value: { kind: "text", text: "it's" } }],
    });
    expect(sql).toBe(`UPDATE "we""ird" SET "a""b" = 'it''s' WHERE "id" = 1`);
  });

  it("writes every staged value as a string literal, whatever it looks like", () => {
    // The editor produces text and only text. The engine coerces it by the
    // target column's type (Postgres assignment cast from an `unknown`
    // literal), so a numeric-looking edit still goes out quoted — guessing
    // its type here would be the client overriding the column's.
    const sql = buildUpdateSql({
      ...base,
      edits: [{ column: "age", value: { kind: "text", text: "42" } }],
    });
    expect(sql).toContain(`SET "age" = '42' WHERE`);
  });

  describe("the WHERE key", () => {
    it("encodes a numeric identity value bare", () => {
      // Typed from the row, not round-tripped through text: `= 7` matches an
      // integer key, `= '7'` would need a cast Postgres will not always make.
      expect(buildUpdateSql({ ...base, key: [{ column: "id", value: 7 }] })).toContain(
        `WHERE "id" = 7`,
      );
    });

    it("encodes a text identity value as a quoted literal, escaped", () => {
      expect(buildUpdateSql({ ...base, key: [{ column: "sku", value: "a'b" }] })).toContain(
        `WHERE "sku" = 'a''b'`,
      );
    });

    it("encodes a null identity value as IS NULL", () => {
      // `= NULL` is never true. A primary key is never null, but the
      // predicate has to be correct for the unique-key fallback this shape
      // leaves room for.
      expect(buildUpdateSql({ ...base, key: [{ column: "opt", value: null }] })).toContain(
        `WHERE "opt" IS NULL`,
      );
    });

    it("joins a composite key with AND, in key order", () => {
      const sql = buildUpdateSql({
        ...base,
        key: [
          { column: "tenant", value: "acme" },
          { column: "id", value: 3 },
        ],
      });
      expect(sql).toContain(`WHERE "tenant" = 'acme' AND "id" = 3`);
    });
  });

  describe("refusals", () => {
    it("refuses when nothing was edited", () => {
      // An UPDATE with an empty SET is a syntax error; more to the point,
      // there is nothing to write.
      expect(() => buildUpdateSql({ ...base, edits: [] })).toThrowError(WriteBackError);
      try {
        buildUpdateSql({ ...base, edits: [] });
      } catch (err) {
        expect((err as WriteBackError).kind).toBe(WriteBackErrorKind.NoEdits);
      }
    });

    it("refuses an unkeyed update rather than rewriting the table", () => {
      // The single most damaging thing this module could emit is an UPDATE
      // with no WHERE. It is a throw, not a fallback.
      expect(() => buildUpdateSql({ ...base, key: [] })).toThrowError(WriteBackError);
      try {
        buildUpdateSql({ ...base, key: [] });
      } catch (err) {
        expect((err as WriteBackError).kind).toBe(WriteBackErrorKind.EmptyKey);
      }
    });

    it("refuses a blob identity value, naming the column", () => {
      // A blob has no safe literal form for a WHERE comparison. Encoding it
      // as its base64 text would compare against the wrong thing and could
      // match a different row.
      try {
        buildUpdateSql({
          ...base,
          key: [{ column: "digest", value: { $blob: "AAEC" } }],
        });
        expect.unreachable("expected a refusal");
      } catch (err) {
        expect((err as WriteBackError).kind).toBe(WriteBackErrorKind.UnsupportedKeyType);
        expect((err as WriteBackError).message).toContain("digest");
      }
    });
  });

  it("never emits an UPDATE without a WHERE", () => {
    // A property, not an example: whatever it returns, it is keyed.
    const sql = buildUpdateSql(base);
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
    // path is not ported (ADR-0063 decision 2 dropped it).
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
