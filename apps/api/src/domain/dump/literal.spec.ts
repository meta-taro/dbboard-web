import { describe, expect, it } from "vitest";

import { encodeBlob } from "../values/value";
import { valueLiteral } from "./literal";

describe("valueLiteral", () => {
  it("renders null as the bare keyword", () => {
    expect(valueLiteral(null)).toBe("NULL");
  });

  it("quotes integers so a boolean column accepts them", () => {
    // pgOidToValue maps BOOL to 1/0, and Postgres refuses to assign an
    // integer to a boolean column. A quoted literal is `unknown`-typed and
    // coerces to whichever column it lands in — the whole reason this
    // module quotes numbers rather than emitting them bare.
    expect(valueLiteral(1)).toBe("'1'");
    expect(valueLiteral(0)).toBe("'0'");
    expect(valueLiteral(-7)).toBe("'-7'");
  });

  it("round-trips finite reals through the shortest form that reparses", () => {
    for (const x of [0.1, 1.5, -2.25, 1e-7, 1e20, 0]) {
      const literal = valueLiteral(x);
      expect(literal.startsWith("'")).toBe(true);
      expect(Number(literal.slice(1, -1))).toBe(x);
    }
  });

  it("spells non-finite reals the way Postgres does", () => {
    // Unlike desktop's Postgres path, web really can hold these: FLOAT8
    // decodes through Number(s), and Number("NaN") is NaN.
    expect(valueLiteral(Number.NaN)).toBe("'NaN'");
    expect(valueLiteral(Number.POSITIVE_INFINITY)).toBe("'Infinity'");
    expect(valueLiteral(Number.NEGATIVE_INFINITY)).toBe("'-Infinity'");
  });

  it("doubles an embedded single quote", () => {
    expect(valueLiteral("O'Brien")).toBe("'O''Brien'");
    expect(valueLiteral("''")).toBe("''''''");
  });

  it("leaves a backslash alone", () => {
    // standard_conforming_strings has been on by default since 9.1, so a
    // backslash is an ordinary character. Doubling it here would store two.
    expect(valueLiteral("C:\\tmp")).toBe("'C:\\tmp'");
  });

  it("renders the empty string as an empty literal, not NULL", () => {
    expect(valueLiteral("")).toBe("''");
  });

  it("renders a blob as lowercase-hex bytea", () => {
    expect(valueLiteral(encodeBlob(new Uint8Array([0x00, 0x0f, 0xff])))).toBe("'\\x000fff'::bytea");
  });

  it("renders an empty blob as an empty bytea", () => {
    expect(valueLiteral(encodeBlob(new Uint8Array([])))).toBe("'\\x'::bytea");
  });
});
