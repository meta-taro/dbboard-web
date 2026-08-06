import { describe, expect, it } from "vitest";
import { libsqlColumnType, libsqlValueToValue, sqliteJsonToValue } from "./libsql-value-mapping";
import { TypeConversionError } from "../domain/errors";
import { isBlobValue, decodeBlob, type BlobValue } from "../domain/values/value";

// Desktop's `convert_value` (crates/dbboard-turso/src/lib.rs) is a five-arm
// match onto a five-variant `Value`. Web's `Value` has four shapes and no
// integer/real distinction, so the mapping has to make decisions desktop
// never faced — every test below pins one of them.

describe("libsqlValueToValue", () => {
  it("maps NULL and a missing cell alike", () => {
    expect(libsqlValueToValue(null)).toBeNull();
    expect(libsqlValueToValue(undefined)).toBeNull();
  });

  it("keeps a text value as a string", () => {
    expect(libsqlValueToValue("hello")).toBe("hello");
  });

  it("keeps an empty string distinct from NULL", () => {
    // SQLite stores '' as TEXT, not as NULL. Collapsing them would make a
    // dumped INSERT write the wrong thing back.
    expect(libsqlValueToValue("")).toBe("");
  });

  it("keeps a real as a number", () => {
    expect(libsqlValueToValue(1.5)).toBe(1.5);
  });

  it("narrows an integer that survives the round trip", () => {
    // libSQL is opened with intMode "bigint", so every INTEGER arrives as a
    // bigint regardless of magnitude. A bigint is not JSON, so it must
    // become one of web's four shapes here rather than at serialisation.
    expect(libsqlValueToValue(42n)).toBe(42);
    expect(libsqlValueToValue(0n)).toBe(0);
    expect(libsqlValueToValue(-42n)).toBe(-42);
  });

  it("renders an integer past the safe range as a decimal string", () => {
    // Same rule `pgOidToValue` applies to int8: narrow only when it round
    // trips losslessly, otherwise carry the digits as text. SQLite's
    // INTEGER is 64-bit, so this is reachable with an ordinary rowid.
    const big = 9_007_199_254_740_993n; // MAX_SAFE_INTEGER + 2
    expect(libsqlValueToValue(big)).toBe("9007199254740993");
    expect(libsqlValueToValue(-9_007_199_254_740_993n)).toBe("-9007199254740993");
  });

  it("keeps the boundary itself a number", () => {
    expect(libsqlValueToValue(BigInt(Number.MAX_SAFE_INTEGER))).toBe(Number.MAX_SAFE_INTEGER);
    expect(libsqlValueToValue(BigInt(Number.MIN_SAFE_INTEGER))).toBe(Number.MIN_SAFE_INTEGER);
  });

  it("renders a non-finite real as text rather than letting JSON eat it", () => {
    // `JSON.stringify(Infinity)` is the string "null" — the cell would
    // arrive at the grid indistinguishable from a real NULL. SQLite reaches
    // this with `SELECT 9e999`.
    expect(libsqlValueToValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(libsqlValueToValue(Number.NEGATIVE_INFINITY)).toBe("-Infinity");
    expect(libsqlValueToValue(Number.NaN)).toBe("NaN");
  });

  it("tags a blob so it survives JSON", () => {
    const bytes = new Uint8Array([0, 1, 255]);
    const mapped = libsqlValueToValue(bytes.buffer);
    expect(isBlobValue(mapped)).toBe(true);
    expect(Array.from(decodeBlob(mapped as BlobValue))).toEqual([0, 1, 255]);
  });

  it("tags a blob delivered as a view rather than a buffer", () => {
    // The driver has returned both shapes across versions, and a
    // `Uint8Array` fed to `Buffer.from` as if it were an ArrayBuffer
    // silently produces the wrong bytes.
    const mapped = libsqlValueToValue(new Uint8Array([7, 8]));
    expect(isBlobValue(mapped)).toBe(true);
    expect(Array.from(decodeBlob(mapped as BlobValue))).toEqual([7, 8]);
  });

  it("respects a view's window into a larger buffer", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    const window = backing.subarray(1, 3);
    const mapped = libsqlValueToValue(window);
    expect(Array.from(decodeBlob(mapped as BlobValue))).toEqual([2, 3]);
  });

  it("falls back to text for a shape it does not know", () => {
    // Not reachable from today's driver. It is here because the
    // alternative — returning the object and letting it reach JSON — puts
    // a shape on the wire that `docs/api-contract.md` does not describe.
    expect(libsqlValueToValue(true)).toBe("true");
  });
});

describe("libsqlColumnType", () => {
  it("passes a declared type through", () => {
    expect(libsqlColumnType("INTEGER")).toBe("INTEGER");
  });

  it("reports no declared type as null", () => {
    // An expression column (`SELECT 1 + 1`) has no declared type, and
    // SQLite's typeless columns report an empty string. Both mean the same
    // thing to the grid, and desktop's `declared_type` is an Option.
    expect(libsqlColumnType(undefined)).toBeNull();
    expect(libsqlColumnType(null)).toBeNull();
    expect(libsqlColumnType("")).toBeNull();
  });
});

// The JSON-envelope sibling (0031 slice B). Same storage classes, a
// different wire: D1's `/raw` hands back `serde_json`-shaped cells, so the
// arms that differ from `libsqlValueToValue` are the ones JSON forces —
// booleans exist, bigints do not, and a blob arrives as an array of byte
// numbers. Mirrors desktop `convert_json_value`
// (crates/dbboard-d1/src/lib.rs at b98f7a6).
describe("sqliteJsonToValue", () => {
  it("maps a JSON null and a missing cell alike", () => {
    expect(sqliteJsonToValue(null)).toBeNull();
    expect(sqliteJsonToValue(undefined)).toBeNull();
  });

  it("maps a boolean to SQLite's 1 and 0", () => {
    // SQLite has no boolean storage class, so a `true` on the wire is an
    // INTEGER that JSON happened to spell as a keyword. Desktop calls this
    // arm defensive; it costs one line and keeps a `true` out of a grid
    // whose column reads INTEGER everywhere else.
    expect(sqliteJsonToValue(true)).toBe(1);
    expect(sqliteJsonToValue(false)).toBe(0);
  });

  it("keeps integers and reals as numbers", () => {
    expect(sqliteJsonToValue(42)).toBe(42);
    expect(sqliteJsonToValue(-7)).toBe(-7);
    expect(sqliteJsonToValue(1.5)).toBe(1.5);
  });

  it("keeps text as a string, empty included", () => {
    expect(sqliteJsonToValue("hi")).toBe("hi");
    expect(sqliteJsonToValue("")).toBe("");
  });

  it("reads an array of bytes as a blob", () => {
    const mapped = sqliteJsonToValue([1, 2, 255]);
    expect(isBlobValue(mapped)).toBe(true);
    expect(Array.from(decodeBlob(mapped as BlobValue))).toEqual([1, 2, 255]);
  });

  it("reads an empty array as an empty blob, not as null", () => {
    const mapped = sqliteJsonToValue([]);
    expect(isBlobValue(mapped)).toBe(true);
    expect(Array.from(decodeBlob(mapped as BlobValue))).toEqual([]);
  });

  it("refuses a byte outside 0-255", () => {
    expect(() => sqliteJsonToValue([256])).toThrow(TypeConversionError);
    expect(() => sqliteJsonToValue([-1])).toThrow(TypeConversionError);
    expect(() => sqliteJsonToValue([1.5])).toThrow(TypeConversionError);
  });

  it("refuses a null inside a byte array", () => {
    // Silently reading it as a zero byte would corrupt the blob rather
    // than report that the envelope was not what it claimed to be.
    expect(() => sqliteJsonToValue([1, null, 2])).toThrow(TypeConversionError);
  });

  it("refuses a JSON object", () => {
    // No SQLite storage class produces one. Stringifying it would put a
    // shape on the wire that `docs/api-contract.md` does not describe.
    expect(() => sqliteJsonToValue({ a: 1 })).toThrow(TypeConversionError);
  });

  it("reports a non-finite number as text", () => {
    // Unreachable through `JSON.parse`, which has no spelling for these.
    // Kept because the function's contract is `unknown` in, `Value` out,
    // and `Infinity` reaching JSON would come back as a bare `null` —
    // indistinguishable from a real one.
    expect(sqliteJsonToValue(Number.POSITIVE_INFINITY)).toBe("Infinity");
    expect(sqliteJsonToValue(Number.NaN)).toBe("NaN");
  });
});
