import { z } from "zod";

// Per-record JSON schema for history persistence.
//
// This shape mirrors desktop ADR-0027 verbatim — same field names, same
// types, same `v`, same `kind`, same `status` values, same error
// envelopes. The schema is the cross-repo contract; the storage
// location and write path are web's call. See `.claude/decisions.md`
// for the web-side ADR and
// `.claude/issues/0023-history-v2-mirror.md` for scope.
//
// v:2 added the top-level `kind` discriminator so AI calls can be
// recorded alongside SQL calls. `kind: "query"` is the v:1 shape
// rebadged — no field added, none removed.
//
// Forward-compat policy (ADR-0027 § Forward-compat, ticket 0023):
//   - Writers emit only the documented fields for their `kind`.
//   - Readers tolerate unknown top-level fields silently (Zod strips).
//   - Records with an unknown `v`, `kind`, `status` or `intent` fail
//     safeParse so the caller drops them whole and ticks an observable
//     counter — never a partial parse.
//   - v:1 records stay readable: `historyRecordV1Schema` accepts them
//     and `upgradeV1Record` lifts them to the equivalent v:2 query
//     record. See ticket 0023 § "The one design decision" for why the
//     read path upgrades rather than preserving v:1 bytes.

// RFC 3339 UTC, millisecond precision, `Z` suffix only. Matches the
// output of `new Date().toISOString()` in modern Node. The brief is
// explicit: no microseconds, no offset suffix.
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Mirrors the desktop DbError taxonomy (ADR-0009 / ADR-0004 / ADR-0012).
// Kept inline rather than importing `ErrorCategory` from
// `./errors/categorized-error.ts` because a wire-format schema should
// freeze its accepted values even if the runtime type widens.
const QUERY_ERROR_CATEGORY = z.enum([
  "query",
  "type_conversion",
  "connection",
  "schema",
  "capability",
]);

// Mirrors the desktop AiError variants (ADR-0023 §5). Deliberately a
// *different* enum from the query taxonomy: an AI call cannot fail with
// `schema`, and a query cannot fail with `provider`. Note the absence
// of `cancelled` — cancel is a top-level status, not a failure
// category (ADR-0026 Decision 12).
const AI_ERROR_CATEGORY = z.enum(["network", "provider", "configuration"]);

const queryErrorEnvelope = z.object({
  category: QUERY_ERROR_CATEGORY,
  message: z.string(),
});

const aiErrorEnvelope = z.object({
  category: AI_ERROR_CATEGORY,
  message: z.string(),
});

const timestamp = z.string().regex(TS_PATTERN, "ts must be RFC 3339 UTC with ms precision (.sssZ)");

// ---- v:2 -------------------------------------------------------------

const queryRecord = z.object({
  v: z.literal(2),
  kind: z.literal("query"),
  ts: timestamp,
  conn: z.string().min(1),
  actor: z.union([z.string().min(1), z.null()]),
  sql: z.string(),
  status: z.enum(["ok", "error"]),
  duration_ms: z.number().int().min(0),
  rows: z.union([z.number().int().min(0), z.null()]),
  rows_affected: z.union([z.number().int().min(0), z.null()]),
  error: z.union([queryErrorEnvelope, z.null()]),
});

const aiRecord = z.object({
  v: z.literal(2),
  kind: z.literal("ai"),
  ts: timestamp,
  // Null when the call had no DB context — an AI record is not tied to
  // a connection the way a query record is.
  conn: z.union([z.string().min(1), z.null()]),
  actor: z.union([z.string().min(1), z.null()]),
  intent: z.enum(["explain", "suggest_sql"]),
  // No redaction, no normalisation — same stance as the query record's
  // `sql` (ADR-0027 Decision 8). Access control around this store is a
  // separate web-side concern; solving it here would put web out of
  // contract.
  //
  // Content is verbatim but length is not: the writer caps this at
  // AI_TEXT_CAP_BYTES (Decision 10). Bare `z.string()` rather than a
  // `.max()` is deliberate — see the cap's note below on why the reader
  // stays permissive.
  prompt: z.string(),
  // On `cancelled`, the partial accumulator at cancel time. The user
  // paid for those bytes. Capped on write, as `prompt` is.
  response: z.string(),
  status: z.enum(["ok", "error", "cancelled"]),
  duration_ms: z.number().int().min(0),
  // Null when the provider surfaced no Usage event before the terminal
  // one. When present, cumulative at terminal time.
  tokens_in: z.union([z.number().int().min(0), z.null()]),
  tokens_out: z.union([z.number().int().min(0), z.null()]),
  provider: z.string().min(1),
  model: z.string().min(1),
  // Informational, not load-bearing: the brief tolerates unknown values
  // here rather than dropping the record, unlike `intent` and `status`.
  // Hence a bare string, not an enum — the `other:<text>` escape hatch
  // means the value set is open by design.
  stop_reason: z.union([z.string(), z.null()]),
  error: z.union([aiErrorEnvelope, z.null()]),
});

export const historyRecordSchema = z
  .discriminatedUnion("kind", [queryRecord, aiRecord])
  .superRefine((record, ctx) => {
    // `cancelled` is not a failure, so it lands in the ok-shaped branch:
    // anything that is not `error` must carry `error: null`.
    if (record.status !== "error" && record.error !== null) {
      ctx.addIssue({
        code: "custom",
        message: `error must be null when status=${record.status}`,
        path: ["error"],
      });
    }
    if (record.status === "error" && record.error === null) {
      ctx.addIssue({
        code: "custom",
        message: "error is required when status=error",
        path: ["error"],
      });
    }
    if (record.kind === "query" && record.rows !== null && record.rows_affected !== null) {
      ctx.addIssue({
        code: "custom",
        message: "rows and rows_affected are mutually exclusive",
        path: ["rows_affected"],
      });
    }
  });

export type HistoryQueryRecord = z.infer<typeof queryRecord>;
export type HistoryAiRecord = z.infer<typeof aiRecord>;
export type HistoryRecord = HistoryQueryRecord | HistoryAiRecord;

export type HistoryErrorEnvelope = z.infer<typeof queryErrorEnvelope>;
export type HistoryAiErrorEnvelope = z.infer<typeof aiErrorEnvelope>;

// ---- writer-side text cap (ADR-0027 Decision 10) ---------------------
//
// Deliberately *not* enforced by the schema above. The cap is a writer
// policy; the reader stays permissive so a record written by another
// tool, an older build, or a future cap value is still readable.
// Desktop draws the line in the same place — the cap lives in
// `AiRecordWire::from_entry`, and its reader has no length bound.

/**
 * Persisted-text cap for AI prompts and responses, in UTF-8 bytes.
 *
 * Mirrors desktop's `AI_TEXT_CAP_BYTES`. The rationale there is
 * rotation budget: a long multi-turn session can produce hundreds of
 * KiB for a record nobody reads back in full. Web has no rotation yet,
 * but the cap is part of the record contract rather than a local
 * storage optimisation — a web-written record has to be
 * indistinguishable from a desktop-written one.
 */
export const AI_TEXT_CAP_BYTES = 64 * 1024;

/**
 * Appended when {@link truncateForPersistence} actually fires, so a
 * reader can tell "the user wrote exactly this much" from "the writer
 * trimmed at the cap".
 *
 * The leading space and the absence of an ellipsis are both load-bearing
 * — this string is compared byte-for-byte against desktop output. Note
 * ADR-0027 Decision 10's prose renders it as `… [truncated at 64 KiB]`;
 * the shipped constant in crates/dbboard-ui/src/history.rs does not have
 * the ellipsis, and the implementation is what the bytes have to match.
 */
export const AI_TEXT_TRUNCATED_MARKER = " [truncated at 64 KiB]";

/**
 * Cap `text` at {@link AI_TEXT_CAP_BYTES} UTF-8 bytes, backing off to the
 * code-point boundary at-or-below the cap and appending
 * {@link AI_TEXT_TRUNCATED_MARKER}. Strings at or under the cap are
 * returned unchanged.
 *
 * Byte-for-byte equivalent to desktop's `truncate_for_persistence`.
 * Two details carry the equivalence:
 *
 * - The cap counts **UTF-8 bytes**, so this works on a `Buffer` rather
 *   than slicing the JS string, whose length is UTF-16 code units. For
 *   CJK text the two differ by 3x.
 * - "Char boundary" is Rust's `is_char_boundary`, i.e. a *code point*
 *   boundary, not a grapheme cluster. A ZWJ emoji sequence can be split
 *   between its components — matching the reference matters more here
 *   than being smarter than it.
 */
export function truncateForPersistence(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= AI_TEXT_CAP_BYTES) return text;

  // Walk back off any UTF-8 continuation byte (0b10xxxxxx). This is the
  // negation of Rust's `is_char_boundary`, which is why the loop
  // condition looks inverted relative to the reference.
  let end = AI_TEXT_CAP_BYTES;
  while (end > 0 && (bytes[end] & 0b1100_0000) === 0b1000_0000) end -= 1;

  return bytes.subarray(0, end).toString("utf8") + AI_TEXT_TRUNCATED_MARKER;
}

// ---- v:1 (read-only legacy) ------------------------------------------

const v1Record = z.object({
  v: z.literal(1),
  ts: timestamp,
  conn: z.string().min(1),
  actor: z.union([z.string().min(1), z.null()]),
  sql: z.string(),
  status: z.enum(["ok", "error"]),
  duration_ms: z.number().int().min(0),
  rows: z.union([z.number().int().min(0), z.null()]),
  rows_affected: z.union([z.number().int().min(0), z.null()]),
  error: z.union([queryErrorEnvelope, z.null()]),
});

/**
 * The v:1 record shape, retained so desktop-emitted v:1 files stay
 * readable. Nothing writes v:1 any more — this is a reader.
 */
export const historyRecordV1Schema = v1Record.superRefine((record, ctx) => {
  if (record.status === "ok" && record.error !== null) {
    ctx.addIssue({
      code: "custom",
      message: "error must be null when status=ok",
      path: ["error"],
    });
  }
  if (record.status === "error" && record.error === null) {
    ctx.addIssue({
      code: "custom",
      message: "error is required when status=error",
      path: ["error"],
    });
  }
  if (record.rows !== null && record.rows_affected !== null) {
    ctx.addIssue({
      code: "custom",
      message: "rows and rows_affected are mutually exclusive",
      path: ["rows_affected"],
    });
  }
});

export type HistoryRecordV1 = z.infer<typeof historyRecordV1Schema>;

/**
 * Lift a v:1 record to the equivalent v:2 `kind: "query"` record.
 *
 * Field-for-field identical apart from `v` and the added discriminator
 * — v:2 added no field to the query shape and removed none, which is
 * what makes the upgrade total rather than best-effort.
 */
export function upgradeV1Record(record: HistoryRecordV1): HistoryQueryRecord {
  return {
    v: 2,
    kind: "query",
    ts: record.ts,
    conn: record.conn,
    actor: record.actor,
    sql: record.sql,
    status: record.status,
    duration_ms: record.duration_ms,
    rows: record.rows,
    rows_affected: record.rows_affected,
    error: record.error,
  };
}
