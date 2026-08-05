/**
 * `Value` → SQL literal rendering for a logical dump — the web mirror of
 * desktop's `crates/dbboard-core/src/dump/literal.rs` (ADR-0049).
 *
 * A dumped `INSERT` has to re-parse and re-load, so every cell needs a
 * syntactically valid literal. That is not what `JSON.stringify` gives, and
 * it is not what a blob's `{ $blob }` wrapper gives either.
 *
 * **Everything except `NULL` and blobs is emitted as a quoted literal**, and
 * the target column's type coerces it. Desktop renders numbers bare, which it
 * can afford because its `Value` distinguishes `Integer` from `Real` and its
 * adapters preserve the distinction. Web's `Value` collapses both into
 * `number` at the contract boundary (JSON has no integer type), and — the
 * part that actually forces the decision — `pgOidToValue` decodes `BOOL` to
 * `1` / `0`. A bare `1` cannot be assigned to a `boolean` column, so a
 * bare-rendered dump would be valid SQL that fails to load. A quoted `'1'` is
 * `unknown`-typed and Postgres resolves it against whatever column it lands
 * in: `boolean`, `integer`, `numeric`, `text` alike.
 *
 * This is the rule `write-back.ts` already follows for edited cells, for the
 * same reason. The cost is that a dump is Postgres-family only; web ships
 * nothing else, and the dialect parameter arrives with MySQL in rung 7 — as a
 * parameter on this function, not as a second copy of it.
 *
 * Two things fall out of quoting rather than needing their own code:
 *
 * - **Non-finite reals.** `FLOAT8` decodes through `Number(s)`, so unlike
 *   desktop's Postgres path a `Value` here really can hold `NaN` or
 *   `Infinity` — and `'NaN'` / `'Infinity'` / `'-Infinity'` are exactly how
 *   Postgres spells them. `String()` already produces those three spellings.
 * - **Large and small magnitudes.** `String(1e21)` is `"1e+21"`, which
 *   Postgres accepts for every numeric type.
 *
 * One known loss: `String(-0)` is `"0"`, so negative zero dumps as zero. No
 * engine distinguishes them in a comparison and no column type preserves the
 * sign through a text round-trip, so this is not worth a branch.
 */
import type { Value } from "../values/value";
import { decodeBlob, isBlobValue } from "../values/value";
import { quoteLiteral } from "../write-back";

/**
 * Render `value` as a SQL literal.
 *
 * - `null` → the bare keyword `NULL`.
 * - a blob → `'\xHEX'::bytea`, lowercase hex. Standard-conforming strings are
 *   on by default from Postgres 9.1, so the backslash is literal and bytea's
 *   hex input format parses it.
 * - everything else → a single-quoted literal with `'` doubled.
 */
export function valueLiteral(value: Value): string {
  if (value === null) return "NULL";
  if (isBlobValue(value)) return blobLiteral(decodeBlob(value));
  return quoteLiteral(String(value));
}

function blobLiteral(bytes: Uint8Array): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return `'\\x${hex}'::bytea`;
}
