import { describe, expect, it } from "vitest";
import type {
  HistoryAiRecord,
  HistoryQueryRecord,
  HistoryRecordV1,
} from "../domain/history-record";
import { parseHistoryNdjson } from "./parse-history-ndjson";

// Ticket 0021 — closes the last unticked Phase 5 DoD bullet:
//   "Reader tolerates unknown fields and drops records with unknown
//    `v` / `status` with an observable counter."
// Extended by ticket 0023 (v:2) with the same guarantee for unknown
// `kind` and unknown `intent`.
//
// Each counter is exercised independently; the aggregation case proves
// counter independence across a mixed batch. Pre-schema attribution of
// the typed drops is deliberate — Zod alone would conflate every drop
// into "invalid shape", but the DoD requires operators see *why* a
// record was dropped, not just *that* it was.

function v1Record(overrides: Partial<HistoryRecordV1> = {}): HistoryRecordV1 {
  return {
    v: 1,
    ts: "2026-06-25T12:00:00.000Z",
    conn: "conn-a",
    actor: null,
    sql: "SELECT 1",
    status: "ok",
    duration_ms: 5,
    rows: 1,
    rows_affected: null,
    error: null,
    ...overrides,
  };
}

function queryRecord(overrides: Partial<HistoryQueryRecord> = {}): HistoryQueryRecord {
  return {
    v: 2,
    kind: "query",
    ts: "2026-06-25T12:00:00.000Z",
    conn: "conn-a",
    actor: null,
    sql: "SELECT 1",
    status: "ok",
    duration_ms: 5,
    rows: 1,
    rows_affected: null,
    error: null,
    ...overrides,
  };
}

function aiRecord(overrides: Partial<HistoryAiRecord> = {}): HistoryAiRecord {
  return {
    v: 2,
    kind: "ai",
    ts: "2026-06-25T12:00:00.000Z",
    conn: null,
    actor: null,
    intent: "explain",
    prompt: "SELECT 1",
    response: "It selects the constant 1.",
    status: "ok",
    duration_ms: 900,
    tokens_in: 12,
    tokens_out: 34,
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    stop_reason: "end_turn",
    error: null,
    ...overrides,
  };
}

function asLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

const ZERO_STATS = {
  accepted: 0,
  dropped_invalid_json: 0,
  dropped_unknown_v: 0,
  dropped_unknown_kind: 0,
  dropped_unknown_status: 0,
  dropped_unknown_intent: 0,
  dropped_invalid_shape: 0,
};

describe("parseHistoryNdjson (0021, extended by 0023)", () => {
  it("returns empty records and all-zero stats for empty input", () => {
    const result = parseHistoryNdjson("");
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual(ZERO_STATS);
  });

  it("returns empty records and all-zero stats when input is only a trailing newline", () => {
    // LF-terminated empty file: the empty final element must not count
    // as a malformed-JSON drop.
    const result = parseHistoryNdjson("\n");
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual(ZERO_STATS);
  });

  it("accepts a v:2 query record", () => {
    const record = queryRecord();
    const result = parseHistoryNdjson(asLine(record));
    expect(result.records).toEqual([record]);
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("accepts a v:2 ai record", () => {
    const record = aiRecord();
    const result = parseHistoryNdjson(asLine(record));
    expect(result.records).toEqual([record]);
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("accepts a v:1 record and upgrades it to kind: query", () => {
    // Brief 0008 § Forward-compat: "v:1 records remain readable by v:2
    // readers — implicit kind: query". The reader upgrades rather than
    // preserving v:1 bytes; ticket 0023 records why.
    const legacy = v1Record();
    const result = parseHistoryNdjson(asLine(legacy));
    expect(result.records).toEqual([{ ...legacy, v: 2, kind: "query" }]);
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("accepts a v:1 error record and carries its envelope through the upgrade", () => {
    const legacy = v1Record({
      status: "error",
      rows: null,
      error: { category: "connection", message: "upstream gone" },
    });
    const result = parseHistoryNdjson(asLine(legacy));
    expect(result.records).toEqual([{ ...legacy, v: 2, kind: "query" }]);
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("accepts a forward-compat record with an unknown extra field and strips the field", () => {
    // Forward-compat: readers must tolerate unknown fields silently.
    // Zod's default strip handles this; we just confirm the counter does
    // not bump and the field is gone from the parsed shape.
    const line = asLine({ ...queryRecord(), unknown_field: "x" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).not.toHaveProperty("unknown_field");
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("drops a record from a future schema version and ticks dropped_unknown_v", () => {
    const line = asLine({ ...queryRecord(), v: 3 });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_unknown_v: 1 });
  });

  it("drops an unknown kind and ticks dropped_unknown_kind", () => {
    const line = asLine({ ...queryRecord(), kind: "telemetry" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_unknown_kind: 1 });
  });

  it("drops a v:2 record with no kind as an invalid shape, not an unknown kind", () => {
    // A missing discriminator is a malformed record, not a record from a
    // vocabulary this reader does not know. Keeping the two apart is the
    // whole point of the typed counters.
    const { kind: _kind, ...withoutKind } = queryRecord();
    void _kind;
    const result = parseHistoryNdjson(asLine(withoutKind));
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_shape: 1 });
  });

  it("drops an unrecognised status and ticks dropped_unknown_status", () => {
    const line = asLine({ ...queryRecord(), status: "weird" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_unknown_status: 1 });
  });

  it("drops status=cancelled on a query record as an unknown status", () => {
    // `cancelled` is a real status — for AI records. On a query record
    // it is out of vocabulary, and the counter should say so rather than
    // reporting a generic shape failure.
    const line = asLine({ ...queryRecord(), status: "cancelled" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_unknown_status: 1 });
  });

  it("accepts status=cancelled on an ai record with error: null", () => {
    const record = aiRecord({
      status: "cancelled",
      response: "It selects the",
      tokens_in: null,
      tokens_out: null,
      stop_reason: null,
      error: null,
    });
    const result = parseHistoryNdjson(asLine(record));
    expect(result.records).toEqual([record]);
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("drops an unknown ai intent and ticks dropped_unknown_intent", () => {
    const line = asLine({ ...aiRecord(), intent: "summarize" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_unknown_intent: 1 });
  });

  it("tolerates an unknown stop_reason rather than dropping the record", () => {
    // Informational field: brief 0008 is explicit that unknown values
    // here are tolerated, unlike intent and status.
    const record = aiRecord({ stop_reason: "other:provider-said-so" });
    const result = parseHistoryNdjson(asLine(record));
    expect(result.records).toEqual([record]);
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("drops a malformed JSON line and ticks dropped_invalid_json", () => {
    const result = parseHistoryNdjson("{not json\n");
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_json: 1 });
  });

  it("drops a schema-failing line (missing required field) and ticks dropped_invalid_shape", () => {
    // Drop `conn` — a required field on a query record. v, kind and
    // status are all well-formed, so this falls through to safeParse and
    // lands in dropped_invalid_shape, not the typed counters above.
    const { conn: _conn, ...rest } = queryRecord();
    void _conn;
    const result = parseHistoryNdjson(asLine(rest));
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_shape: 1 });
  });

  it("drops a schema-failing line where v/kind/status look fine but ts is malformed", () => {
    // Belt-and-braces: this proves the pre-check does not swallow real
    // shape failures.
    const line = asLine({ ...queryRecord(), ts: "not-a-timestamp" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_shape: 1 });
  });

  it("drops an ai record whose cancelled status carries an error envelope", () => {
    // Cancel is not a failure. A writer that pairs the two has misread
    // the contract; the shape counter is the right place for it.
    const line = asLine(
      aiRecord({
        status: "cancelled",
        error: { category: "network", message: "aborted" },
      }),
    );
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_shape: 1 });
  });

  it("aggregates counters independently across a mixed batch and preserves accepted order", () => {
    const goodQuery = queryRecord({ conn: "conn-a", sql: "SELECT 1" });
    const goodAi = aiRecord({ prompt: "SELECT 2" });
    const legacy = v1Record({ conn: "conn-b", sql: "SELECT 3" });
    const futureV = { ...queryRecord(), v: 99 };
    const badKind = { ...queryRecord(), kind: "telemetry" };
    const badStatus = { ...queryRecord(), status: "draft" };
    const badIntent = { ...aiRecord(), intent: "translate" };
    const { ts: _ts, ...badShape } = queryRecord();
    void _ts;

    const bytes = [
      asLine(goodQuery),
      "{garbage\n",
      asLine(futureV),
      asLine(goodAi),
      asLine(badKind),
      asLine(legacy),
      asLine(badStatus),
      asLine(badIntent),
      asLine(badShape),
    ].join("");

    const result = parseHistoryNdjson(bytes);

    expect(result.records).toEqual([goodQuery, goodAi, { ...legacy, v: 2, kind: "query" }]);
    expect(result.stats).toEqual({
      accepted: 3,
      dropped_invalid_json: 1,
      dropped_unknown_v: 1,
      dropped_unknown_kind: 1,
      dropped_unknown_status: 1,
      dropped_unknown_intent: 1,
      dropped_invalid_shape: 1,
    });
  });
});
