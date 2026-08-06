/**
 * Which SQL dialect a driver speaks — the web mirror of the `SqlDialect` enum
 * and `dialect_for_adapter_id` in desktop's
 * `crates/dbboard-core/src/write_back.rs` (ADR-0068, ADR-0072).
 *
 * Everything in `domain` that emits SQL text takes one of these. Before rung 7
 * there was one real adapter and every emitter quoted ANSI with a comment
 * saying the parameter arrives with MySQL; this module is that parameter.
 *
 * ## Three values, not two
 *
 * ADR-0072 names two — `'ansi'` and `'mysql'` — because the frontend function
 * it describes only quotes *identifiers*, and SQLite and Postgres both use
 * `"…"` for those. The backend also emits *literals*, and there the two part
 * company: a blob is `X'…'` in SQLite and `'\x…'::bytea` in Postgres, and a
 * non-finite real is `NULL` in SQLite and `'NaN'` in Postgres. So this enum is
 * desktop's three-way one and `sql-build.ts`'s is ADR-0072's two-way one. They
 * are not the same type on purpose.
 *
 * ## Two functions, because "unknown" is not the same question twice
 *
 * {@link dialectForDriver} is the table, and it answers `null` for a driver
 * that is not in it — desktop's `Option`, kept so a drift test can tell "not
 * in the table" apart from "resolved to the default".
 * {@link dialectFor} is what emitters call, and it applies the fallback.
 */

/** The dialects web can emit SQL text for. */
export type SqlDialect = "sqlite" | "postgres" | "mysql";

/**
 * The dialect assumed for a driver that is not in the table.
 *
 * ADR-0072 decision 1 fixes the direction: ANSI, because it is what every
 * dialect except MySQL accepts for an identifier, so it is the right guess for
 * an adapter added after the table — and being wrong is a syntax error the
 * user sees rather than a silently wrong result. `postgres` is web's spelling
 * of ANSI here because the backend dialect also decides literals, and the
 * Postgres arm is what every emitter produced before this seam existed: the
 * fallback changes nothing that already worked.
 *
 * The honest caveat is the reason `static-adapter-factory.spec.ts` has a drift
 * test. For identifiers the fallback is safe; for literals it is only *safe
 * for Postgres*. A SQLite-wire driver that reaches the fallback dumps blobs
 * Postgres-style, which is exactly the bug slice B shipped for the length of
 * one slice.
 */
export const DEFAULT_DIALECT: SqlDialect = "postgres";

// A Map, not an object literal: the key arrives as a driver string, and a
// literal would answer `constructor` with a function. Same trap
// `StaticAdapterFactory` guards at the same boundary.
//
// The Postgres row carries three names with no adapter behind them yet —
// `neon`, `supabase`, `aurora-dsql`. They are desktop's names for hosted
// Postgres, and having them resolve before their adapters exist is the point:
// the table is not a list of what web ships, it is what a driver name means.
const DIALECT_BY_DRIVER: ReadonlyMap<string, SqlDialect> = new Map<string, SqlDialect>([
  ["turso", "sqlite"],
  ["d1", "sqlite"],
  ["postgres", "postgres"],
  ["neon", "postgres"],
  ["supabase", "postgres"],
  ["aurora-dsql", "postgres"],
  ["mysql", "mysql"],
  // The do-nothing adapter executes nothing and builds no SQL, so its entry
  // is inert. It is here so the drift test can be total: an exception list
  // is a place for a real driver to hide.
  ["null", "postgres"],
]);

/**
 * The dialect `driver` speaks, or `null` when the driver is not in the table.
 *
 * Callers that need an answer should use {@link dialectFor}. This one exists
 * for the drift test, which has to be able to see the absence.
 */
export function dialectForDriver(driver: string): SqlDialect | null {
  return DIALECT_BY_DRIVER.get(driver) ?? null;
}

/**
 * The dialect to emit SQL in for `driver`, falling back to
 * {@link DEFAULT_DIALECT} for a driver this build does not know — including
 * `undefined`, which is what a caller with no connection in hand passes.
 */
export function dialectFor(driver: string | null | undefined): SqlDialect {
  if (driver === null || driver === undefined) return DEFAULT_DIALECT;
  return dialectForDriver(driver) ?? DEFAULT_DIALECT;
}
