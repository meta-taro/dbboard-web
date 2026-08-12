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

  // Desktop's `displayCell` renders a document as `JSON.stringify(cell.$json)`
  // for exactly this reason, and the contract names the failure by name: a
  // tree must never reach the grid as "[object Object]".
  it("renders a { $json } envelope as its JSON text", () => {
    expect(formatValue({ $json: { a: 1 } })).toEqual({ kind: "json", text: '{"a":1}' });
    expect(formatValue({ $json: [1, 2] })).toEqual({ kind: "json", text: "[1,2]" });
  });

  it("never renders a document as [object Object]", () => {
    // A property, not an example: whatever the payload, the cell is readable.
    for (const payload of [{ a: [1, { b: null }] }, {}, [], "text", 0, false]) {
      expect(formatValue({ $json: payload }).text).not.toContain("[object Object]");
    }
  });

  // The contract is explicit that these are different values: bare `null` is
  // SQL NULL, `{ $json: null }` is a document whose content is JSON null.
  // Collapsing them would tell the user a column is empty when it is not.
  it("keeps a null document apart from SQL NULL", () => {
    expect(formatValue({ $json: null })).toEqual({ kind: "json", text: "null" });
    expect(formatValue(null)).toEqual({ kind: "null", text: "NULL" });
  });

  // The payload is opaque. A document that holds a "$blob" key is that
  // document — walking into the tree would summarise bytes the row never had.
  it("does not treat a $blob key inside a document as a blob", () => {
    expect(formatValue({ $json: { $blob: "AAAA" } })).toEqual({
      kind: "json",
      text: '{"$blob":"AAAA"}',
    });
  });

  // Rule 4 of the contract: a Text cell and a document may render to the same
  // characters, and only the tag tells them apart. The grid styles by `kind`,
  // so the kind is the thing that has to differ.
  it("distinguishes a document from a string that renders identically", () => {
    expect(formatValue('{"a":1}').kind).toBe("string");
    expect(formatValue({ $json: { a: 1 } }).kind).toBe("json");
  });
});
