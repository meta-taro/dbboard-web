import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "../domain/history-record";
import { parseHistoryNdjson } from "./parse-history-ndjson";

// Ticket 0021 — closes the last unticked Phase 5 DoD bullet:
//   "Reader tolerates unknown fields and drops records with unknown
//    `v` / `status` with an observable counter."
//
// Each counter is exercised independently; the aggregation case proves
// counter independence across a mixed batch. Pre-schema attribution of
// unknown-v / unknown-status is deliberate — Zod alone would conflate
// every drop into "invalid shape", but the DoD requires operators see
// *why* a record was dropped, not just *that* it was.

function validRecord(overrides: Partial<HistoryRecord> = {}): HistoryRecord {
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

function asLine(record: unknown): string {
  return `${JSON.stringify(record)}\n`;
}

const ZERO_STATS = {
  accepted: 0,
  dropped_invalid_json: 0,
  dropped_unknown_v: 0,
  dropped_unknown_status: 0,
  dropped_invalid_shape: 0,
};

describe("parseHistoryNdjson (0021)", () => {
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

  it("accepts a single well-formed record", () => {
    const record = validRecord();
    const result = parseHistoryNdjson(asLine(record));
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).toEqual(record);
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("accepts a forward-compat record with an unknown extra field and strips the field", () => {
    // ADR-0017 §6 forward-compat: readers must tolerate unknown fields
    // silently. Zod's default strip handles this; we just confirm the
    // counter does not bump and the field is gone from the parsed shape.
    const line = asLine({ ...validRecord(), unknown_field: "x" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]).not.toHaveProperty("unknown_field");
    expect(result.stats).toEqual({ ...ZERO_STATS, accepted: 1 });
  });

  it("drops a record with v !== 1 and ticks dropped_unknown_v", () => {
    const line = asLine({ ...validRecord(), v: 2 });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_unknown_v: 1 });
  });

  it("drops a record with an unrecognised status and ticks dropped_unknown_status", () => {
    const line = asLine({ ...validRecord(), status: "weird" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_unknown_status: 1 });
  });

  it("drops a malformed JSON line and ticks dropped_invalid_json", () => {
    const result = parseHistoryNdjson("{not json\n");
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_json: 1 });
  });

  it("drops a schema-failing line (missing required field) and ticks dropped_invalid_shape", () => {
    // Drop `conn` — a required v:1 field. v and status are both
    // well-formed, so this falls through to safeParse and lands in
    // dropped_invalid_shape, not the typed counters above.
    const { conn: _conn, ...rest } = validRecord();
    void _conn;
    const result = parseHistoryNdjson(asLine(rest));
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_shape: 1 });
  });

  it("drops a schema-failing line where the v/status look fine but ts is malformed", () => {
    // Belt-and-braces: this proves the pre-check does not swallow real
    // shape failures. ts is wrong but v=1 and status="ok" are valid, so
    // the drop must land on dropped_invalid_shape.
    const line = asLine({ ...validRecord(), ts: "not-a-timestamp" });
    const result = parseHistoryNdjson(line);
    expect(result.records).toEqual([]);
    expect(result.stats).toEqual({ ...ZERO_STATS, dropped_invalid_shape: 1 });
  });

  it("aggregates counters independently across a mixed batch and preserves accepted order", () => {
    const goodA = validRecord({ conn: "conn-a", sql: "SELECT 1" });
    const goodB = validRecord({ conn: "conn-b", sql: "SELECT 2" });
    const futureV = { ...validRecord(), v: 99 };
    const badStatus = { ...validRecord(), status: "draft" };
    const { ts: _ts, ...badShape } = validRecord();
    void _ts;

    const bytes = [
      asLine(goodA),
      "{garbage\n",
      asLine(futureV),
      asLine(goodB),
      asLine(badStatus),
      asLine(badShape),
    ].join("");

    const result = parseHistoryNdjson(bytes);

    expect(result.records).toEqual([goodA, goodB]);
    expect(result.stats).toEqual({
      accepted: 2,
      dropped_invalid_json: 1,
      dropped_unknown_v: 1,
      dropped_unknown_status: 1,
      dropped_invalid_shape: 1,
    });
  });
});
