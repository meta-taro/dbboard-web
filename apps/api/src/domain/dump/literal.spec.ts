import { describe, expect, it } from "vitest";

import { encodeBlob } from "../values/value";
import { valueLiteral } from "./literal";

describe("valueLiteral", () => {
  it("renders null as the bare keyword", () => {
    expect(valueLiteral(null, "postgres")).toBe("NULL");
    expect(valueLiteral(null, "sqlite")).toBe("NULL");
    expect(valueLiteral(null, "mysql")).toBe("NULL");
  });

  it("quotes integers so a boolean column accepts them", () => {
    // pgOidToValue maps BOOL to 1/0, and Postgres refuses to assign an
    // integer to a boolean column. A quoted literal is `unknown`-typed and
    // coerces to whichever column it lands in — the whole reason this
    // module quotes numbers rather than emitting them bare.
    expect(valueLiteral(1, "postgres")).toBe("'1'");
    expect(valueLiteral(0, "postgres")).toBe("'0'");
    expect(valueLiteral(-7, "postgres")).toBe("'-7'");
  });

  it("quotes integers on the other dialects too", () => {
    // SQLite applies column affinity to numeric-looking text and MySQL
    // coerces it, so the one rule holds everywhere and the dialect does not
    // fork here.
    expect(valueLiteral(42, "sqlite")).toBe("'42'");
    expect(valueLiteral(42, "mysql")).toBe("'42'");
  });

  it("round-trips finite reals through the shortest form that reparses", () => {
    for (const x of [0.1, 1.5, -2.25, 1e-7, 1e20, 0]) {
      const literal = valueLiteral(x, "postgres");
      expect(literal.startsWith("'")).toBe(true);
      expect(Number(literal.slice(1, -1))).toBe(x);
    }
  });

  it("spells non-finite reals the way Postgres does", () => {
    // Unlike desktop's Postgres path, web really can hold these: FLOAT8
    // decodes through Number(s), and Number("NaN") is NaN.
    expect(valueLiteral(Number.NaN, "postgres")).toBe("'NaN'");
    expect(valueLiteral(Number.POSITIVE_INFINITY, "postgres")).toBe("'Infinity'");
    expect(valueLiteral(Number.NEGATIVE_INFINITY, "postgres")).toBe("'-Infinity'");
  });

  it("maps a SQLite NaN to NULL and its infinities to an overflowing literal", () => {
    // SQLite has no non-finite literal and stores NaN as NULL itself, so
    // `'NaN'` there would land in the column as the three-character string.
    // `9e999` overflows to ±Inf on parse, which is the form desktop emits.
    expect(valueLiteral(Number.NaN, "sqlite")).toBe("NULL");
    expect(valueLiteral(Number.POSITIVE_INFINITY, "sqlite")).toBe("9e999");
    expect(valueLiteral(Number.NEGATIVE_INFINITY, "sqlite")).toBe("-9e999");
  });

  it("maps every non-finite real to NULL on MySQL", () => {
    // A MySQL DOUBLE cannot hold one, and an out-of-range literal is an
    // error under strict sql_mode. Lossy for ±Infinity, but the value cannot
    // have come out of a MySQL column to begin with.
    expect(valueLiteral(Number.NaN, "mysql")).toBe("NULL");
    expect(valueLiteral(Number.POSITIVE_INFINITY, "mysql")).toBe("NULL");
    expect(valueLiteral(Number.NEGATIVE_INFINITY, "mysql")).toBe("NULL");
  });

  it("doubles an embedded single quote", () => {
    expect(valueLiteral("O'Brien", "postgres")).toBe("'O''Brien'");
    expect(valueLiteral("''", "postgres")).toBe("''''''");
  });

  it("leaves a backslash alone on the ANSI dialects and doubles it on MySQL", () => {
    // standard_conforming_strings has been on by default since 9.1, so a
    // backslash is an ordinary character there and doubling it would store
    // two. MySQL reads it as an escape unless NO_BACKSLASH_ESCAPES is set.
    expect(valueLiteral("C:\\tmp", "postgres")).toBe("'C:\\tmp'");
    expect(valueLiteral("C:\\tmp", "sqlite")).toBe("'C:\\tmp'");
    expect(valueLiteral("C:\\tmp", "mysql")).toBe("'C:\\\\tmp'");
  });

  it("renders the empty string as an empty literal, not NULL", () => {
    expect(valueLiteral("", "postgres")).toBe("''");
  });

  it("renders a blob as lowercase-hex bytea on Postgres", () => {
    expect(valueLiteral(encodeBlob(new Uint8Array([0x00, 0x0f, 0xff])), "postgres")).toBe(
      "'\\x000fff'::bytea",
    );
  });

  it("renders a blob as X'…' on SQLite and MySQL", () => {
    // The bug slice B shipped: D1 advertises `has_table_ddl`, so it can be
    // dumped, and `'\x…'::bytea` is Postgres syntax SQLite cannot parse. The
    // dump loaded nowhere and nothing failed to say so.
    const blob = encodeBlob(new Uint8Array([0x00, 0x0f, 0xff]));
    expect(valueLiteral(blob, "sqlite")).toBe("X'000fff'");
    expect(valueLiteral(blob, "mysql")).toBe("X'000fff'");
  });

  it("renders an empty blob as an empty literal of the dialect's shape", () => {
    expect(valueLiteral(encodeBlob(new Uint8Array([])), "postgres")).toBe("'\\x'::bytea");
    // `X''` is the empty binary string in both engines that read it.
    expect(valueLiteral(encodeBlob(new Uint8Array([])), "sqlite")).toBe("X''");
  });
});
