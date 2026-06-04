import { Logger } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import { encodeBlob } from "../domain/values/value";
import { pgOidToName, pgOidToValue } from "./postgres-type-mapping";

// One test per row of `0004` § Type mapping. The pool is configured to
// return raw text for every OID so the decoder operates on strings; the
// spec inputs mirror exactly what `pg` hands us in that mode.

describe("pgOidToValue", () => {
  it("decodes NULL to null regardless of OID", () => {
    expect(pgOidToValue(23, null)).toBeNull();
    expect(pgOidToValue(700, null)).toBeNull();
    expect(pgOidToValue(99999, null)).toBeNull();
  });

  it("int2 (OID 21) → Integer", () => {
    expect(pgOidToValue(21, "42")).toBe(42);
    expect(pgOidToValue(21, "-7")).toBe(-7);
  });

  it("int4 (OID 23) → Integer", () => {
    expect(pgOidToValue(23, "2147483647")).toBe(2147483647);
  });

  it("int8 (OID 20) within MAX_SAFE_INTEGER → Integer", () => {
    expect(pgOidToValue(20, "9007199254740991")).toBe(9007199254740991);
    expect(pgOidToValue(20, "-9007199254740991")).toBe(-9007199254740991);
  });

  it("int8 (OID 20) beyond MAX_SAFE_INTEGER → Text (round-trip preserved)", () => {
    // 2^63 - 1 — past Number.MAX_SAFE_INTEGER. Returning a number would lose
    // precision, so the contract surfaces it as Text so the UI can show the
    // real digits. Desktop side has the same compromise.
    expect(pgOidToValue(20, "9223372036854775807")).toBe("9223372036854775807");
  });

  it("float4 (OID 700) → Real", () => {
    expect(pgOidToValue(700, "1.5")).toBe(1.5);
  });

  it("float8 (OID 701) → Real", () => {
    expect(pgOidToValue(701, "3.14159265358979")).toBe(3.14159265358979);
  });

  it("numeric (OID 1700) finite and round-trip-clean → Real", () => {
    expect(pgOidToValue(1700, "1.23")).toBe(1.23);
    expect(pgOidToValue(1700, "0")).toBe(0);
  });

  it("numeric (OID 1700) lossy or unparseable → Text", () => {
    // Trailing zero would be lost via Number(): "1.20" → 1.2. Surface as Text
    // to preserve the original precision the user saw in the DB.
    expect(pgOidToValue(1700, "1.20")).toBe("1.20");
    // Beyond Number's safe precision.
    expect(pgOidToValue(1700, "999999999999999999.99")).toBe("999999999999999999.99");
  });

  it("bool (OID 16) → Integer(0|1)", () => {
    expect(pgOidToValue(16, "t")).toBe(1);
    expect(pgOidToValue(16, "f")).toBe(0);
    expect(pgOidToValue(16, "true")).toBe(1);
    expect(pgOidToValue(16, "false")).toBe(0);
  });

  it("bytea (OID 17) hex-escape → Blob base64 (standard alphabet)", () => {
    // "Hello" = 48 65 6c 6c 6f → base64 "SGVsbG8="
    expect(pgOidToValue(17, "\\x48656c6c6f")).toEqual(
      encodeBlob(new Uint8Array([72, 101, 108, 108, 111])),
    );
    expect(pgOidToValue(17, "\\x00ff")).toEqual(encodeBlob(new Uint8Array([0, 255])));
  });

  it("text family (OID 25, 1043, 18, 1042, 19) → Text", () => {
    expect(pgOidToValue(25, "hello")).toBe("hello");
    expect(pgOidToValue(1043, "varchar value")).toBe("varchar value");
    expect(pgOidToValue(18, "c")).toBe("c");
    expect(pgOidToValue(1042, "bpchar value")).toBe("bpchar value");
    expect(pgOidToValue(19, "name_val")).toBe("name_val");
  });

  it("uuid (OID 2950) → Text", () => {
    expect(pgOidToValue(2950, "11111111-2222-3333-4444-555555555555")).toBe(
      "11111111-2222-3333-4444-555555555555",
    );
  });

  it("json (OID 114) → Text (raw JSON text)", () => {
    expect(pgOidToValue(114, '{"a":1}')).toBe('{"a":1}');
  });

  it("jsonb (OID 3802) → Text (raw JSON text)", () => {
    expect(pgOidToValue(3802, '{"b":2}')).toBe('{"b":2}');
  });

  it("timestamp (OID 1114) → ISO 8601 Text (T separator)", () => {
    // Postgres text output uses a space; ISO 8601 strict wants 'T'.
    expect(pgOidToValue(1114, "2024-01-15 10:30:45.123")).toBe("2024-01-15T10:30:45.123");
    expect(pgOidToValue(1114, "2024-01-15 10:30:45")).toBe("2024-01-15T10:30:45");
  });

  it("timestamptz (OID 1184) → ISO 8601 Text with normalized offset", () => {
    // Postgres emits "+00" or "-05"; ISO 8601 wants "+00:00" / "-05:00".
    expect(pgOidToValue(1184, "2024-01-15 10:30:45.123+00")).toBe("2024-01-15T10:30:45.123+00:00");
    expect(pgOidToValue(1184, "2024-01-15 10:30:45-05")).toBe("2024-01-15T10:30:45-05:00");
  });

  it("date (OID 1082) → Text YYYY-MM-DD", () => {
    expect(pgOidToValue(1082, "2024-01-15")).toBe("2024-01-15");
  });

  it("time (OID 1083) → Text HH:MM:SS", () => {
    expect(pgOidToValue(1083, "10:30:45")).toBe("10:30:45");
  });

  it("unknown OID → Text fallback + INFO log", () => {
    const spy = vi.spyOn(Logger.prototype, "log").mockImplementation(() => undefined);
    try {
      // 9999 is not in the catalog of OIDs we map. The decoder must not
      // throw — operators need the value to surface so they can decide
      // whether to add coverage.
      expect(pgOidToValue(9999, "anything")).toBe("anything");
      expect(spy).toHaveBeenCalled();
      const message = spy.mock.calls[0]?.[0];
      expect(String(message)).toMatch(/9999/);
    } finally {
      spy.mockRestore();
    }
  });
});

describe("pgOidToName", () => {
  it("returns the Postgres type name for known OIDs", () => {
    expect(pgOidToName(23)).toBe("int4");
    expect(pgOidToName(25)).toBe("text");
    expect(pgOidToName(1700)).toBe("numeric");
    expect(pgOidToName(2950)).toBe("uuid");
    expect(pgOidToName(3802)).toBe("jsonb");
  });

  it("returns null for unknown OIDs so Column.declared_type can stay nullable", () => {
    expect(pgOidToName(9999)).toBeNull();
  });
});
