/**
 * `Value` → SQL literal rendering for a logical dump — the web mirror of
 * desktop's `crates/dbboard-core/src/dump/literal.rs` (ADR-0049).
 *
 * A dumped `INSERT` has to re-parse and re-load, so every cell needs a
 * syntactically valid literal. That is not what `JSON.stringify` gives, and
 * it is not what a blob's `{ $blob }` wrapper gives either.
 *
 * **Everything except `NULL`, blobs and non-finite reals is emitted as a
 * quoted literal**, and the target column's type coerces it. Desktop renders
 * numbers bare, which it can afford because its `Value` distinguishes
 * `Integer` from `Real` and its adapters preserve the distinction. Web's
 * `Value` collapses both into `number` at the contract boundary (JSON has no
 * integer type), and — the part that actually forces the decision —
 * `pgOidToValue` decodes `BOOL` to `1` / `0`. A bare `1` cannot be assigned to
 * a `boolean` column, so a bare-rendered dump would be valid SQL that fails to
 * load. A quoted `'1'` is `unknown`-typed and Postgres resolves it against
 * whatever column it lands in: `boolean`, `integer`, `numeric`, `text` alike.
 * SQLite and MySQL reach the same place by a different route — column affinity
 * and implicit string-to-number coercion — so the rule holds across all three.
 *
 * This is the rule `write-back.ts` already follows for edited cells, for the
 * same reason.
 *
 * The dialect parameter arrived with rung 7 slice C, on this function rather
 * than as a second copy of it, and it is **required**. Two of the three things
 * it decides are cases where the Postgres spelling is not merely unidiomatic
 * elsewhere but unloadable:
 *
 * - **Blobs.** `'\xHEX'::bytea` is Postgres-only; SQLite and MySQL both read
 *   `X'HEX'`. This one had already shipped wrong: slice B added D1, a
 *   SQLite-wire driver advertising `has_table_ddl` — so dumpable — while this
 *   function still had one arm.
 * - **Non-finite reals.** `FLOAT8` decodes through `Number(s)`, so unlike
 *   desktop's Postgres path a `Value` here really can hold `NaN` or
 *   `Infinity`. Postgres spells those `'NaN'` / `'Infinity'` / `'-Infinity'`
 *   and the quoted form is one of them. SQLite has no such literal and stores
 *   NaN as `NULL`; MySQL's `DOUBLE` cannot hold a non-finite value at all and
 *   rejects an out-of-range literal under strict `sql_mode`. See
 *   {@link realLiteral}.
 *
 * Large and small magnitudes need no branch: `String(1e21)` is `"1e+21"`,
 * which every target accepts for a numeric column.
 *
 * One known loss: `String(-0)` is `"0"`, so negative zero dumps as zero. No
 * engine distinguishes them in a comparison and no column type preserves the
 * sign through a text round-trip, so this is not worth a branch — desktop
 * makes the same trade.
 */
import type { SqlDialect } from "../dialect";
import type { Value } from "../values/value";
import { decodeBlob, isBlobValue, isJsonValue } from "../values/value";
import { quoteLiteral } from "../write-back";

/**
 * Render `value` as a SQL literal valid in `dialect`.
 *
 * - `null` → the bare keyword `NULL`.
 * - a blob → `X'HEX'` on SQLite and MySQL, `'\xHEX'::bytea` on Postgres,
 *   lowercase hex either way (both forms accept either case).
 * - a document → its compact JSON text, quoted like any other string.
 * - a non-finite number → see {@link realLiteral}.
 * - everything else → a single-quoted literal escaped for `dialect`.
 *
 * Both tagged variants are matched before the fall-through, and that is the
 * whole point of testing them: `String({ $json: … })` is `"[object Object]"`,
 * which is a syntactically valid literal for the wrong value — a dump that
 * loads and silently replaces the document with eleven characters of prose.
 */
export function valueLiteral(value: Value, dialect: SqlDialect): string {
  if (value === null) return "NULL";
  if (isBlobValue(value)) return blobLiteral(decodeBlob(value), dialect);
  if (isJsonValue(value)) return quoteLiteral(JSON.stringify(value.$json), dialect);
  if (typeof value === "number" && !Number.isFinite(value)) return realLiteral(value, dialect);
  return quoteLiteral(String(value), dialect);
}

/**
 * A non-finite real, in the only form the target will parse.
 *
 * - **Postgres** has genuine `'NaN'` / `'Infinity'` / `'-Infinity'` float
 *   literals, and `String()` already produces those three spellings, so the
 *   ordinary quoted path is correct there.
 * - **SQLite** has none. NaN becomes `NULL`, which is how SQLite stores it
 *   anyway; ±Infinity becomes the overflowing literal `±9e999`, which SQLite
 *   parses back to ±Inf.
 * - **MySQL** cannot represent either in a `DOUBLE`, so every non-finite value
 *   becomes `NULL`. Lossy for ±Infinity, but such a value cannot have come out
 *   of a MySQL column in the first place.
 */
function realLiteral(x: number, dialect: SqlDialect): string {
  if (dialect === "postgres") return quoteLiteral(String(x), dialect);
  if (dialect === "mysql" || Number.isNaN(x)) return "NULL";
  return x > 0 ? "9e999" : "-9e999";
}

function blobLiteral(bytes: Uint8Array, dialect: SqlDialect): string {
  let hex = "";
  for (const byte of bytes) hex += byte.toString(16).padStart(2, "0");
  return dialect === "postgres" ? `'\\x${hex}'::bytea` : `X'${hex}'`;
}
