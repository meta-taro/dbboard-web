import { TypeConversionError } from "../domain/errors";
import { encodeBlob, type Value } from "../domain/values/value";

/**
 * libSQL cell → contract `Value` (desktop `crates/dbboard-turso`'s
 * `convert_value`, ADR-0003's crate rather than its ADR).
 *
 * Desktop maps five driver variants onto five domain variants and the
 * function is total by construction. Web's `Value` is
 * `null | number | string | { $blob }`, so two of SQLite's five storage
 * classes have to share a shape and the interesting decisions are all about
 * which loss is acceptable:
 *
 * - **INTEGER is 64-bit and JSON's number is not.** The client is opened
 *   with `intMode: "bigint"` (see `turso-adapter.ts`) so the driver never
 *   silently truncates; the narrowing happens here, on the same terms
 *   `pgOidToValue` applies to `int8` — a `number` when it round-trips,
 *   the decimal digits as text when it does not.
 * - **A non-finite REAL is not JSON either.** `JSON.stringify(Infinity)`
 *   emits `null`, which would reach the grid indistinguishable from a real
 *   NULL, so it becomes text instead. SQLite gets there with `SELECT 9e999`.
 *
 * Kept separate from the adapter, and named for libSQL rather than for
 * Turso, because D1 is the same wire (slice B) and will map the same
 * storage classes out of a JSON envelope.
 */

const MAX_SAFE_BIG = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE_BIG = BigInt(Number.MIN_SAFE_INTEGER);

export function libsqlValueToValue(raw: unknown): Value {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "bigint") {
    return raw >= MIN_SAFE_BIG && raw <= MAX_SAFE_BIG ? Number(raw) : raw.toString();
  }

  if (typeof raw === "number") {
    // `String` rather than a fixed sentinel: "Infinity" and "NaN" are what
    // SQLite itself prints, so the cell reads the way the engine reads it.
    return Number.isFinite(raw) ? raw : String(raw);
  }

  if (typeof raw === "string") return raw;

  if (raw instanceof ArrayBuffer) return encodeBlob(new Uint8Array(raw));

  if (ArrayBuffer.isView(raw)) {
    // Not `new Uint8Array(view.buffer)`: a view can be a window into a
    // larger buffer, and reading the whole backing store would return
    // bytes that are not part of this cell.
    const view = raw as ArrayBufferView;
    return encodeBlob(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
  }

  // Unreachable from today's driver. Text is the honest fallback: it keeps
  // the value on the wire in a shape `docs/api-contract.md` describes,
  // which returning the object itself would not.
  return String(raw);
}

/**
 * A `serde_json`-shaped SQLite cell → contract `Value` (desktop
 * `crates/dbboard-d1`'s `convert_json_value`, ADR-0007, slice B).
 *
 * The sibling of `libsqlValueToValue` for the adapter that reads the same
 * storage classes out of a JSON envelope instead of a native driver. It is a
 * separate function rather than a widened one because two arms disagree, and
 * both disagreements are correct where they stand:
 *
 * - **`true` is `1` here and the text `"true"` there.** JSON has a boolean
 *   and SQLite does not, so a `true` in a D1 envelope is an INTEGER the
 *   encoder spelled as a keyword. Coming out of the native driver a boolean
 *   is a shape the driver should never have produced, so the honest answer
 *   is the fallback.
 * - **An array is a blob here and unreachable there.** D1 encodes a BLOB as
 *   an array of byte numbers; the native driver hands back an `ArrayBuffer`.
 *
 * **A precision loss with no fix at this layer.** `JSON.parse` narrows every
 * number to a double before the mapper is called, so a 64-bit INTEGER past
 * 2^53 has already lost its low bits — the digits are gone, not merely
 * mis-shaped. Slice A avoided this with `intMode: "bigint"`; there is no
 * equivalent switch on a JSON body. Fixing it would mean parsing the
 * response text by hand with a reviver that sees the raw literal, which is a
 * cost worth paying only if a real D1 database turns out to hand back rowids
 * that large. Recorded here so the next reader does not conclude the
 * narrowing was overlooked.
 */
export function sqliteJsonToValue(raw: unknown): Value {
  if (raw === null || raw === undefined) return null;

  if (typeof raw === "boolean") return raw ? 1 : 0;

  if (typeof raw === "number") {
    // Same reasoning as the native mapper: a non-finite number would reach
    // the grid as a bare `null` once it passes through JSON.
    return Number.isFinite(raw) ? raw : String(raw);
  }

  if (typeof raw === "string") return raw;

  if (Array.isArray(raw)) return encodeBlob(bytesOf(raw));

  // An object has no SQLite storage class behind it, so the envelope is not
  // what it claimed to be. 422 rather than a stringified object on the wire.
  throw new TypeConversionError(`unsupported JSON value in result cell: ${typeof raw}`);
}

function bytesOf(items: readonly unknown[]): Uint8Array {
  const bytes = new Uint8Array(items.length);
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    // Reading a stray `null` as a zero byte would corrupt the blob quietly;
    // a caller that gets bytes back has no way to tell it happened.
    if (typeof item !== "number" || !Number.isInteger(item) || item < 0 || item > 255) {
      throw new TypeConversionError(`blob byte out of range at index ${i}`);
    }
    bytes[i] = item;
  }
  return bytes;
}

/**
 * A result column's declared type, or `null` where there is none.
 *
 * SQLite reports a typeless column as an empty string and an expression
 * column as no type at all; both mean "the grid has nothing to label this
 * with", which is what desktop's `Option<String>` says.
 */
export function libsqlColumnType(declared: string | null | undefined): string | null {
  return declared === undefined || declared === null || declared === "" ? null : declared;
}
