/**
 * Result-grid sorting: a stable permutation of row indices under a fixed
 * total order over values. The port of desktop ADR-0048 and of
 * `crates/dbboard-core/src/sort.rs`.
 *
 * Two properties this module exists to guarantee:
 *
 * 1. **It reorders display, not data.** Everything here returns a
 *    permutation of indices; nothing sorts a `rows` array in place. Row
 *    indices stay valid for selection and, later, for inline editing.
 * 2. **The order is dbboard's own, not the engine's.** NULLs first, then
 *    numbers by magnitude, then text, then blobs, then documents — decided
 *    here so that a result from any adapter sorts identically and no
 *    comparison can throw. It may differ from what the same `ORDER BY` would
 *    return on the server; that is intentional. This is a client-side view of
 *    a fetched result, not a re-query.
 */
import type { BlobValue, JsonValue, Value } from "../composables/useQueryExecution";

export interface SortKey {
  column: number;
  ascending: boolean;
}

/**
 * Most sort levels tracked at once — a primary, secondary, and tertiary key.
 * Past three, the header indicator stops being legible and the user stops
 * being able to predict the result.
 */
export const MAX_SORT_KEYS = 3;

// Both tagged shapes are narrowed by their key, not by being an object. The
// bug this replaces: `isBlob` returned true for any non-null object, so a
// `$json` cell was a blob to both this and `rank`, and `compareValues` ran
// `compareStrings(undefined, undefined)` — which returns 0 for every pair,
// quietly making a whole column unsortable rather than throwing.
function isBlob(value: Value): value is BlobValue {
  return typeof value === "object" && value !== null && "$blob" in value;
}

function isJson(value: Value): value is JsonValue {
  return typeof value === "object" && value !== null && "$json" in value;
}

/** Bucket index deciding cross-type order. Mirrors `sort.rs`'s `rank`. */
function rank(value: Value): number {
  if (value === null) return 0;
  if (typeof value === "number") return 1;
  if (typeof value === "string") return 2;
  if (isBlob(value)) return 3;
  return 4;
}

const bitsView = new DataView(new ArrayBuffer(8));

/**
 * IEEE-754 total order over doubles, the equivalent of Rust's
 * `f64::total_cmp`. Comparing with `<` would make every NaN incomparable and
 * `-0 < 0` false, which leaves `Array.prototype.sort` free to place them
 * anywhere — the one thing a "total order that cannot panic" must not allow.
 * Reinterpreting the bits as a sign-magnitude integer and folding the
 * negative half gives a single monotone key.
 */
function totalOrderBits(value: number): bigint {
  bitsView.setFloat64(0, value);
  const bits = bitsView.getBigInt64(0);
  return bits < 0n ? bits ^ 0x7fffffffffffffffn : bits;
}

function compareNumbers(a: number, b: number): number {
  const left = totalOrderBits(a);
  const right = totalOrderBits(b);
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function compareStrings(a: string, b: string): number {
  // Deliberately a code-unit comparison, not `localeCompare`: the order must
  // not shift with the user's locale, or the same result would sort two ways
  // on two machines.
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Total order over two cell values. Never throws, and every pair of values
 * is comparable — including NaN, which has no natural position.
 */
export function compareValues(a: Value, b: Value): number {
  const rankA = rank(a);
  const rankB = rank(b);
  if (rankA !== rankB) return rankA < rankB ? -1 : 1;
  if (typeof a === "number" && typeof b === "number") return compareNumbers(a, b);
  if (typeof a === "string" && typeof b === "string") return compareStrings(a, b);
  if (isBlob(a) && isBlob(b)) return compareStrings(a.$blob, b.$blob);
  // A tree has no natural order, so compare the rendered form — the same
  // choice `sort.rs` makes. Stable and predictable is all a display sort asks
  // for; this is not a value equality test, and two documents that differ only
  // in key order compare as different because their text does.
  if (isJson(a) && isJson(b)) {
    return compareStrings(JSON.stringify(a.$json), JSON.stringify(b.$json));
  }
  // Both NULL.
  return 0;
}

/**
 * Compare one column of two rows, tolerating a row shorter than the column
 * index. A missing cell sorts ahead of a present one, so ragged rows stay
 * grouped instead of scattering.
 */
function compareCells(
  left: ReadonlyArray<Value>,
  right: ReadonlyArray<Value>,
  column: number,
): number {
  const hasLeft = column < left.length;
  const hasRight = column < right.length;
  if (!hasLeft && !hasRight) return 0;
  if (!hasLeft) return -1;
  if (!hasRight) return 1;
  return compareValues(left[column] as Value, right[column] as Value);
}

/**
 * The display order for `rows` under `keys`: a permutation of row indices,
 * primary key first. No keys means the natural order.
 *
 * `Array.prototype.sort` is required to be stable (ES2019), which is what
 * makes a row's own position the implicit final tiebreak — so a fourth sort
 * level would be redundant even if one were allowed.
 */
export function sortedRowOrder(
  rows: ReadonlyArray<ReadonlyArray<Value>>,
  keys: ReadonlyArray<SortKey>,
): number[] {
  const order = rows.map((_, index) => index);
  if (keys.length === 0) return order;
  return order.sort((leftIndex, rightIndex) => {
    const left = rows[leftIndex] as ReadonlyArray<Value>;
    const right = rows[rightIndex] as ReadonlyArray<Value>;
    for (const key of keys) {
      const ordering = compareCells(left, right, key.column);
      if (ordering !== 0) return key.ascending ? ordering : -ordering;
    }
    return 0;
  });
}

/**
 * The sort keys a header click produces, given the current ones.
 *
 * A plain click sorts by that column alone, cycling ascending → descending →
 * off. An `additive` click (Ctrl / Shift held) builds a multi-level sort
 * instead: a new column is appended as the next level, and clicking a column
 * that already sorts cycles its own direction ascending → descending → gone.
 *
 * Pure, and returns a fresh array — the caller's state is never edited in
 * place, so a Vue `computed` over the keys reliably invalidates.
 */
export function nextSortKeys(
  keys: ReadonlyArray<SortKey>,
  column: number,
  additive: boolean,
): SortKey[] {
  const existing = keys.findIndex((key) => key.column === column);
  if (additive) {
    if (existing === -1) {
      // At the cap: ignore the extra column rather than silently evicting a
      // level the user set on purpose.
      if (keys.length >= MAX_SORT_KEYS) return keys.map((key) => ({ ...key }));
      return [...keys.map((key) => ({ ...key })), { column, ascending: true }];
    }
    if ((keys[existing] as SortKey).ascending) {
      return keys.map((key, i) => (i === existing ? { ...key, ascending: false } : { ...key }));
    }
    return keys.filter((_, i) => i !== existing).map((key) => ({ ...key }));
  }
  const only = keys.length === 1 ? (keys[0] as SortKey) : null;
  if (only !== null && only.column === column) {
    return only.ascending ? [{ column, ascending: false }] : [];
  }
  return [{ column, ascending: true }];
}
