import { AiError, type AiErrorCategory } from "../domain/ai/ai-error";
import { CategorizedError } from "../domain/errors/categorized-error";
import {
  historyRecordSchema,
  truncateForPersistence,
  type HistoryAiErrorEnvelope,
  type HistoryAiRecord,
  type HistoryErrorEnvelope,
  type HistoryRecord,
} from "../domain/history-record";
import type { QueryResult } from "../domain/values";
import type { HistoryStore } from "./history-store.port";

// Sentinel for the connection-less /query route. ADR-0017 §2 requires
// `conn` to be a non-empty string; the web side carries the convention
// in .claude/decisions.md alongside the rest of the ADR-0017 mirror.
//
// AI records do NOT use it: their `conn` is nullable by schema, so a
// call with no DB context records `null` rather than inventing a
// connection that was never opened.
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

export interface AiRecordContext {
  intent: "explain" | "suggest_sql";
  prompt: string;
  // Nullable, unlike the query path: an AI call need not be bound to a
  // connection.
  connectionId: string | null;
  startTimeMs: number;
  actor: string | null;
  provider: string;
  // The model the call was issued against. Required even on the error
  // path — the schema has no null for it — which is why the provider
  // port exposes `getModel()` rather than only reporting a model back
  // inside a successful response.
  model: string;
}

// camelCase deliberately: snake_case belongs to the wire record and
// nowhere else, so the mapping happens once, at the boundary below.
export interface AiOutcome {
  // On the error path, whatever had accumulated before the failure —
  // empty string when nothing did.
  response: string;
  tokensIn: number | null;
  tokensOut: number | null;
  stopReason: string | null;
  // The model the provider actually served, when it differs from the
  // requested alias. Absent on the error path, where no response exists
  // to report one.
  servedModel?: string;
}

// Maps `QueryResult` + `RecordContext` (success path) or a thrown
// `CategorizedError` (error path) to an ADR-0027-shaped record and
// hands it to the store. The schema is safeParse'd before insert so a
// bug in this mapper surfaces immediately rather than corrupting the
// log.
//
// There is deliberately no `recordAiCancelled`. The v:2 schema accepts
// `status: "cancelled"` because desktop emits it and web must read it,
// but web's AI surface is non-streaming request/response with no abort
// path, so a web-side cancel writer would be unreachable code. Ticket
// 0023 records this; add it when Stage 2 wires streaming.
export class RecordHistory {
  constructor(
    private readonly store: HistoryStore,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async recordSuccess(ctx: RecordContext, result: QueryResult): Promise<void> {
    const { rows, rows_affected } = mapRowsFields(result);
    await this.persist({
      v: 2,
      kind: "query",
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
      v: 2,
      kind: "query",
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

  async recordAiSuccess(ctx: AiRecordContext, outcome: AiOutcome): Promise<void> {
    await this.persist(this.aiRecord(ctx, outcome, "ok", null));
  }

  async recordAiError(ctx: AiRecordContext, outcome: AiOutcome, err: unknown): Promise<void> {
    await this.persist(this.aiRecord(ctx, outcome, "error", mapAiError(err)));
  }

  // Field order deliberately matches the declaration order of desktop's
  // `AiRecordWire` (crates/dbboard-ui/src/history.rs) — note `status`
  // sits between `response` and `duration_ms`, not at the end. Key order
  // is what makes the two implementations byte-equivalent under
  // `serde_json::to_string` / `JSON.stringify`. `persist()` re-imposes
  // this order anyway (Zod rebuilds the object from the schema shape),
  // but a writer that visibly disagrees with the wire order is a trap
  // for the next person to bypass the schema.
  private aiRecord(
    ctx: AiRecordContext,
    outcome: AiOutcome,
    status: HistoryAiRecord["status"],
    error: HistoryAiErrorEnvelope | null,
  ): HistoryAiRecord {
    return {
      v: 2,
      kind: "ai",
      ts: new Date(this.nowMs()).toISOString(),
      conn: ctx.connectionId,
      actor: ctx.actor,
      intent: ctx.intent,
      // Capped, not redacted (ADR-0027 Decisions 8 + 10). The cap fires
      // at the write boundary only — the value handed to the provider
      // and returned on the wire stays whole.
      prompt: truncateForPersistence(ctx.prompt),
      response: truncateForPersistence(outcome.response),
      status,
      duration_ms: this.nowMs() - ctx.startTimeMs,
      tokens_in: outcome.tokensIn,
      tokens_out: outcome.tokensOut,
      provider: ctx.provider,
      // The served build is the more precise answer to "what produced
      // this?", so it wins over the requested alias when reported.
      model: outcome.servedModel ?? ctx.model,
      stop_reason: outcome.stopReason,
      error,
    };
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

// history-record.ts deliberately freezes the query-record wire category
// enum at the five DB categories (ADR-0027 §2). The runtime
// ErrorCategory union is wider — it includes the web-only AI categories
// — so anything that isn't one of the five is normalised to "query"
// here. AI calls have their own writer and their own envelope
// (`mapAiError` below), so this only fires if a future code path routes
// an AI failure into the query path by mistake; when it does, the
// recorded category stays inside the contract instead of silently
// widening it.
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

// The AI envelope has its own three-value taxonomy, disjoint from the DB
// one. Only `AiError` carries a category we can trust — it is set by the
// adapter, the one layer that can distinguish a transport failure from
// an upstream rejection. Everything else, including a DB
// `CategorizedError` that reached here by mistake, records as
// "provider": the call failed somewhere past our boundary and nothing
// has proven otherwise.
const AI_ERROR_FALLBACK: AiErrorCategory = "provider";

function mapAiError(err: unknown): HistoryAiErrorEnvelope {
  if (err instanceof AiError) {
    return { category: err.category, message: err.message };
  }
  if (err instanceof Error) {
    return { category: AI_ERROR_FALLBACK, message: err.message };
  }
  return { category: AI_ERROR_FALLBACK, message: "unknown error" };
}
