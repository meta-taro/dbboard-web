import { describe, expect, it } from "vitest";
import { formatValue } from "../app/utils/format-value";

describe("formatValue", () => {
  it("maps null to { kind: 'null', text: 'NULL' }", () => {
    expect(formatValue(null)).toEqual({ kind: "null", text: "NULL" });
  });

  it("maps numbers (positive, zero, negative) to their String() form", () => {
    expect(formatValue(42)).toEqual({ kind: "number", text: "42" });
    expect(formatValue(0)).toEqual({ kind: "number", text: "0" });
    expect(formatValue(-1.5)).toEqual({ kind: "number", text: "-1.5" });
  });

  it("preserves NaN as 'NaN' under the 'number' kind", () => {
    expect(formatValue(Number.NaN)).toEqual({ kind: "number", text: "NaN" });
  });

  it("passes strings through verbatim under the 'string' kind", () => {
    expect(formatValue("")).toEqual({ kind: "string", text: "" });
    expect(formatValue("hello")).toEqual({ kind: "string", text: "hello" });
    // Multi-byte must survive untouched — drivers may return UTF-8 strings.
    expect(formatValue("日本語")).toEqual({ kind: "string", text: "日本語" });
  });

  it("renders a { $blob } envelope as <blob: N chars>", () => {
    expect(formatValue({ $blob: "" })).toEqual({ kind: "blob", text: "<blob: 0 chars>" });
    expect(formatValue({ $blob: "AAAA" })).toEqual({ kind: "blob", text: "<blob: 4 chars>" });
  });
});
