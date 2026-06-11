import { describe, expect, it } from "vitest";
import { historyRecordSchema, type HistoryRecord } from "./history-record";

// Verbatim example from ADR-0017 §2 (also reproduced in the web ticket
// 0009 § "Record schema"). Used as the round-trip fixture so a future
// editor of the schema cannot quietly drift away from the shared shape.
const adr0017Example: HistoryRecord = {
  v: 1,
  ts: "2026-06-04T14:22:01.123Z",
  conn: "prod-pg",
  actor: "alice@example.com",
  sql: "SELECT * FROM users LIMIT 10",
  status: "ok",
  duration_ms: 42,
  rows: 10,
  rows_affected: null,
  error: null,
};

describe("historyRecordSchema", () => {
  it("accepts the ADR-0017 §2 verbatim example", () => {
    expect(historyRecordSchema.safeParse(adr0017Example).success).toBe(true);
  });

  it("rejects an unknown schema version (v: 2 -> drop on read)", () => {
    const result = historyRecordSchema.safeParse({ ...adr0017Example, v: 2 });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown status (cancelled -> drop on read)", () => {
    const result = historyRecordSchema.safeParse({ ...adr0017Example, status: "cancelled" });
    expect(result.success).toBe(false);
  });

  it("rejects ts without millisecond precision", () => {
    const result = historyRecordSchema.safeParse({
      ...adr0017Example,
      ts: "2026-06-04T14:22:01Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects ts with an offset suffix instead of Z", () => {
    const result = historyRecordSchema.safeParse({
      ...adr0017Example,
      ts: "2026-06-04T14:22:01.123+09:00",
    });
    expect(result.success).toBe(false);
  });

  it("preserves ts under Date round-trip", () => {
    const parsed = historyRecordSchema.parse(adr0017Example);
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it("accepts actor: null", () => {
    expect(historyRecordSchema.safeParse({ ...adr0017Example, actor: null }).success).toBe(true);
  });

  it("rejects actor: empty string (per brief: never emit empty)", () => {
    const result = historyRecordSchema.safeParse({ ...adr0017Example, actor: "" });
    expect(result.success).toBe(false);
  });

  it("rejects status=ok with error non-null", () => {
    const result = historyRecordSchema.safeParse({
      ...adr0017Example,
      status: "ok",
      error: { category: "query", message: "should be null when ok" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a status=error record with the matching envelope", () => {
    expect(
      historyRecordSchema.safeParse({
        ...adr0017Example,
        status: "error",
        rows: null,
        rows_affected: null,
        error: { category: "query", message: "division by zero" },
      }).success,
    ).toBe(true);
  });

  it("rejects status=error with error: null", () => {
    const result = historyRecordSchema.safeParse({
      ...adr0017Example,
      status: "error",
      rows: null,
      rows_affected: null,
      error: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects rows and rows_affected both non-null (mutually exclusive)", () => {
    const result = historyRecordSchema.safeParse({
      ...adr0017Example,
      rows: 10,
      rows_affected: 5,
    });
    expect(result.success).toBe(false);
  });

  it("accepts a DDL record with both rows and rows_affected null", () => {
    expect(
      historyRecordSchema.safeParse({
        ...adr0017Example,
        rows: null,
        rows_affected: null,
      }).success,
    ).toBe(true);
  });

  it("accepts a DML record with rows: null and rows_affected: int", () => {
    expect(
      historyRecordSchema.safeParse({
        ...adr0017Example,
        rows: null,
        rows_affected: 3,
      }).success,
    ).toBe(true);
  });

  it("rejects an unknown error category (web-internal leak guard)", () => {
    const result = historyRecordSchema.safeParse({
      ...adr0017Example,
      status: "error",
      rows: null,
      rows_affected: null,
      error: { category: "internal", message: "should not surface" },
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields silently (forward-compat reader)", () => {
    const parsed = historyRecordSchema.parse({
      ...adr0017Example,
      future_field: 42,
    });
    expect(parsed).not.toHaveProperty("future_field");
  });

  it("rejects negative duration_ms", () => {
    const result = historyRecordSchema.safeParse({ ...adr0017Example, duration_ms: -1 });
    expect(result.success).toBe(false);
  });

  it("rejects non-integer duration_ms", () => {
    const result = historyRecordSchema.safeParse({ ...adr0017Example, duration_ms: 42.5 });
    expect(result.success).toBe(false);
  });
});
