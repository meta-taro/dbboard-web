import { describe, expect, it } from "vitest";
import {
  CapabilityError,
  CategorizedError,
  ConnectionError,
  QueryError,
  SchemaError,
  TypeConversionError,
} from "./index";

describe("CategorizedError subclasses", () => {
  it("each subclass pins its category string per docs/api-contract.md", () => {
    // Category strings are the wire-format contract — renaming any of these
    // is a breaking change. Pinned here so a typo in source is caught.
    expect(new QueryError("x").category).toBe("query");
    expect(new TypeConversionError("x").category).toBe("type_conversion");
    expect(new ConnectionError("x").category).toBe("connection");
    expect(new SchemaError("x").category).toBe("schema");
    expect(new CapabilityError("x").category).toBe("capability");
  });

  it("preserves the message verbatim (no category prefix)", () => {
    // docs/api-contract.md: "message is the bare detail string (no category
    // prefix), so it can be reconstructed into a domain error without
    // doubling the prefix."
    const e = new QueryError("syntax error at line 1");
    expect(e.message).toBe("syntax error at line 1");
  });

  it("each subclass is instanceof CategorizedError and Error", () => {
    const cases = [
      new QueryError("q"),
      new TypeConversionError("t"),
      new ConnectionError("c"),
      new SchemaError("s"),
      new CapabilityError("k"),
    ];
    for (const e of cases) {
      expect(e).toBeInstanceOf(CategorizedError);
      expect(e).toBeInstanceOf(Error);
    }
  });

  it("preserves the subclass name for stack traces / logs", () => {
    expect(new QueryError("x").name).toBe("QueryError");
    expect(new CapabilityError("x").name).toBe("CapabilityError");
  });
});
