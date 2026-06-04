import { z } from "zod";

// Per-record JSON schema for query-history persistence.
//
// This shape mirrors desktop ADR-0017 §2 verbatim — same field names,
// same types, same `v`, same `status` values, same error envelope. The
// schema is the cross-repo contract; the storage location and write
// path are web's call. See `.claude/decisions.md` for the web-side ADR
// and `.claude/issues/0009-web-history-schema-mirror.md` for scope.
//
// Forward-compat policy (ADR-0017 §6, ticket 0009 § "Forward-compat"):
//   - Writers emit only the documented fields.
//   - Readers tolerate unknown fields silently (Zod's default strip).
//   - Records with `v` other than 1 or unknown `status` fail safeParse
//     so the caller drops them and ticks an observable counter.

// RFC 3339 UTC, millisecond precision, `Z` suffix only. Matches the
// output of `new Date().toISOString()` in modern Node. The brief is
// explicit: no microseconds, no offset suffix.
const TS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

// Mirrors the desktop DbError taxonomy (ADR-0009 / ADR-0004 / ADR-0012).
// Kept inline rather than importing `ErrorCategory` from
// `./errors/categorized-error.ts` because a wire-format schema should
// freeze its accepted values even if the runtime type widens.
const ERROR_CATEGORY = z.enum(["query", "type_conversion", "connection", "schema", "capability"]);

const errorEnvelope = z.object({
  category: ERROR_CATEGORY,
  message: z.string(),
});

const baseRecord = z.object({
  v: z.literal(1),
  ts: z.string().regex(TS_PATTERN, "ts must be RFC 3339 UTC with ms precision (.sssZ)"),
  conn: z.string().min(1),
  actor: z.union([z.string().min(1), z.null()]),
  sql: z.string(),
  status: z.enum(["ok", "error"]),
  duration_ms: z.number().int().min(0),
  rows: z.union([z.number().int().min(0), z.null()]),
  rows_affected: z.union([z.number().int().min(0), z.null()]),
  error: z.union([errorEnvelope, z.null()]),
});

export const historyRecordSchema = baseRecord.superRefine((record, ctx) => {
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

export type HistoryRecord = z.infer<typeof historyRecordSchema>;
export type HistoryErrorEnvelope = z.infer<typeof errorEnvelope>;
