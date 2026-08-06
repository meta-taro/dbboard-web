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
 * A result column's declared type, or `null` where there is none.
 *
 * SQLite reports a typeless column as an empty string and an expression
 * column as no type at all; both mean "the grid has nothing to label this
 * with", which is what desktop's `Option<String>` says.
 */
export function libsqlColumnType(declared: string | null | undefined): string | null {
  return declared === undefined || declared === null || declared === "" ? null : declared;
}
