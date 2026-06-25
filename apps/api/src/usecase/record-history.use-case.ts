import { CategorizedError } from "../domain/errors/categorized-error";
import {
  historyRecordSchema,
  type HistoryErrorEnvelope,
  type HistoryRecord,
} from "../domain/history-record";
import type { QueryResult } from "../domain/values";
import type { HistoryStore } from "./history-store.port";

// Sentinel for the connection-less /query route. ADR-0017 §2 requires
// `conn` to be a non-empty string; the web side carries the convention
// in .claude/decisions.md alongside the rest of the ADR-0017 mirror.
const DEFAULT_CONN = "_default";

export interface RecordContext {
  sql: string;
  connectionId: string | undefined;
  // Wall-clock at request receipt (epoch ms). `duration_ms` derives
  // from `nowMs() - startTimeMs` so a single injected clock keeps the
  // ts and the duration on the same time base.
  startTimeMs: number;
  actor: string | null;
}

// Maps `QueryResult` + `RecordContext` (success path) or a thrown
// `CategorizedError` (error path) to an ADR-0017-shaped record and
// hands it to the store. The schema is safeParse'd before insert so a
// bug in this mapper surfaces immediately rather than corrupting the
// log.
export class RecordHistory {
  constructor(
    private readonly store: HistoryStore,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async recordSuccess(ctx: RecordContext, result: QueryResult): Promise<void> {
    const { rows, rows_affected } = mapRowsFields(result);
    await this.persist({
      v: 1,
      ts: new Date(this.nowMs()).toISOString(),
      conn: ctx.connectionId ?? DEFAULT_CONN,
      actor: ctx.actor,
      sql: ctx.sql,
      status: "ok",
      duration_ms: this.nowMs() - ctx.startTimeMs,
      rows,
      rows_affected,
      error: null,
    });
  }

  async recordError(ctx: RecordContext, err: unknown): Promise<void> {
    await this.persist({
      v: 1,
      ts: new Date(this.nowMs()).toISOString(),
      conn: ctx.connectionId ?? DEFAULT_CONN,
      actor: ctx.actor,
      sql: ctx.sql,
      status: "error",
      duration_ms: this.nowMs() - ctx.startTimeMs,
      rows: null,
      rows_affected: null,
      error: mapError(err),
    });
  }

  private async persist(record: HistoryRecord): Promise<void> {
    // A failed safeParse here is a programmer bug (we own both sides of
    // the mapping). Throwing surfaces it in tests and dev; the caller
    // (interceptor) swallows the throw so a malformed record never fails
    // a user-facing request.
    const parsed = historyRecordSchema.safeParse(record);
    if (!parsed.success) {
      throw new Error(`history record failed schema validation: ${parsed.error.message}`);
    }
    await this.store.record(parsed.data);
  }
}

// SELECT-class: columns present, log row count. DML: no columns but
// `rows_affected > 0`, log that. DDL / no-result ok: both null. Matches
// ADR-0017 §2's "mutually exclusive" rule.
function mapRowsFields(result: QueryResult): { rows: number | null; rows_affected: number | null } {
  if (result.columns.length > 0) {
    return { rows: result.rows.length, rows_affected: null };
  }
  if (result.rows_affected > 0) {
    return { rows: null, rows_affected: result.rows_affected };
  }
  return { rows: null, rows_affected: null };
}

// history-record.ts deliberately freezes the wire category enum at the
// five DB categories (ADR-0017 §2). The runtime ErrorCategory union is
// wider — it includes the web-only AI categories — so anything that
// isn't one of the five is normalised to "query" here. Belt-and-braces:
// AI calls don't go through the history interceptor today (AiController
// has no @UseInterceptors), but if a future code path accidentally
// routes one in, the recorded category stays inside the contract
// instead of silently widening it.
const HISTORY_CATEGORIES = new Set<HistoryErrorEnvelope["category"]>([
  "query",
  "type_conversion",
  "connection",
  "schema",
  "capability",
]);

function mapError(err: unknown): HistoryErrorEnvelope {
  if (err instanceof CategorizedError) {
    const category = HISTORY_CATEGORIES.has(err.category as HistoryErrorEnvelope["category"])
      ? (err.category as HistoryErrorEnvelope["category"])
      : "query";
    return { category, message: err.message };
  }
  if (err instanceof Error) {
    return { category: "query", message: err.message };
  }
  return { category: "query", message: "unknown error" };
}
