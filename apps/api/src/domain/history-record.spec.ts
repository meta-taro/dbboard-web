import { describe, expect, it } from "vitest";
import {
  AI_TEXT_CAP_BYTES,
  AI_TEXT_TRUNCATED_MARKER,
  historyRecordSchema,
  historyRecordV1Schema,
  truncateForPersistence,
  upgradeV1Record,
  type HistoryAiRecord,
  type HistoryQueryRecord,
  type HistoryRecord,
} from "./history-record";

// Verbatim example from desktop brief 0008 § "kind: query" — the v:1
// shape rebadged. Used as the round-trip fixture so a future editor of
// the schema cannot quietly drift away from the shared shape.
const queryExample: HistoryQueryRecord = {
  v: 2,
  kind: "query",
  ts: "2026-06-30T05:12:01.456Z",
  conn: "prod-pg",
  actor: "alice@example.com",
  sql: "SELECT * FROM users LIMIT 10",
  status: "ok",
  duration_ms: 42,
  rows: 10,
  rows_affected: null,
  error: null,
};

// Verbatim example from desktop brief 0008 § "kind: ai".
const aiExample: HistoryAiRecord = {
  v: 2,
  kind: "ai",
  ts: "2026-06-30T05:12:01.456Z",
  conn: null,
  actor: null,
  intent: "explain",
  prompt: "SELECT * FROM users …",
  response: "This query reads …",
  status: "ok",
  duration_ms: 4231,
  tokens_in: 412,
  tokens_out: 218,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  stop_reason: "end_turn",
  error: null,
};

// The ADR-0017 §2 example — the shape desktop wrote before the bump.
// Kept verbatim: this is the back-compat evidence.
const v1Example = {
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

describe("historyRecordSchema — kind: query", () => {
  it("accepts the brief 0008 verbatim example", () => {
    expect(historyRecordSchema.safeParse(queryExample).success).toBe(true);
  });

  it("rejects v:1 (the union is v:2 only; v:1 arrives via upgradeV1Record)", () => {
    const { kind: _kind, ...withoutKind } = queryExample;
    expect(historyRecordSchema.safeParse({ ...withoutKind, v: 1 }).success).toBe(false);
  });

  it("rejects a future version (v:3 -> drop on read)", () => {
    expect(historyRecordSchema.safeParse({ ...queryExample, v: 3 }).success).toBe(false);
  });

  it("rejects an unknown kind (-> drop on read)", () => {
    expect(historyRecordSchema.safeParse({ ...queryExample, kind: "telemetry" }).success).toBe(
      false,
    );
  });

  it("rejects a missing kind (the discriminator is required at v:2)", () => {
    const { kind: _kind, ...withoutKind } = queryExample;
    expect(historyRecordSchema.safeParse(withoutKind).success).toBe(false);
  });

  // `cancelled` is an AI-only status. A query either ran or it didn't.
  it("rejects status cancelled on a query record", () => {
    expect(historyRecordSchema.safeParse({ ...queryExample, status: "cancelled" }).success).toBe(
      false,
    );
  });

  it("rejects ts without millisecond precision", () => {
    expect(
      historyRecordSchema.safeParse({ ...queryExample, ts: "2026-06-30T05:12:01Z" }).success,
    ).toBe(false);
  });

  it("rejects ts with an offset suffix instead of Z", () => {
    expect(
      historyRecordSchema.safeParse({ ...queryExample, ts: "2026-06-30T05:12:01.456+09:00" })
        .success,
    ).toBe(false);
  });

  it("preserves ts under Date round-trip", () => {
    const parsed = historyRecordSchema.parse(queryExample);
    expect(new Date(parsed.ts).toISOString()).toBe(parsed.ts);
  });

  it("accepts actor: null", () => {
    expect(historyRecordSchema.safeParse({ ...queryExample, actor: null }).success).toBe(true);
  });

  it("rejects actor: empty string (per brief: never emit empty)", () => {
    expect(historyRecordSchema.safeParse({ ...queryExample, actor: "" }).success).toBe(false);
  });

  it("rejects status=ok with error non-null", () => {
    const result = historyRecordSchema.safeParse({
      ...queryExample,
      error: { category: "query", message: "should be null when ok" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts a status=error record with the matching envelope", () => {
    expect(
      historyRecordSchema.safeParse({
        ...queryExample,
        status: "error",
        rows: null,
        rows_affected: null,
        error: { category: "query", message: "division by zero" },
      }).success,
    ).toBe(true);
  });

  it("rejects status=error with error: null", () => {
    const result = historyRecordSchema.safeParse({
      ...queryExample,
      status: "error",
      rows: null,
      rows_affected: null,
      error: null,
    });
    expect(result.success).toBe(false);
  });

  it("rejects rows and rows_affected both non-null (mutually exclusive)", () => {
    expect(
      historyRecordSchema.safeParse({ ...queryExample, rows: 10, rows_affected: 5 }).success,
    ).toBe(false);
  });

  it("accepts a DDL record with both rows and rows_affected null", () => {
    expect(
      historyRecordSchema.safeParse({ ...queryExample, rows: null, rows_affected: null }).success,
    ).toBe(true);
  });

  it("accepts a DML record with rows: null and rows_affected: int", () => {
    expect(
      historyRecordSchema.safeParse({ ...queryExample, rows: null, rows_affected: 3 }).success,
    ).toBe(true);
  });

  it("rejects an unknown error category (web-internal leak guard)", () => {
    const result = historyRecordSchema.safeParse({
      ...queryExample,
      status: "error",
      rows: null,
      rows_affected: null,
      error: { category: "internal", message: "should not surface" },
    });
    expect(result.success).toBe(false);
  });

  // The query category enum stays frozen at the five DB categories. The
  // AI categories are a different enum on a different variant; leaking
  // one into the other is the mistake this guards against.
  it("rejects an AI error category on a query record", () => {
    const result = historyRecordSchema.safeParse({
      ...queryExample,
      status: "error",
      rows: null,
      rows_affected: null,
      error: { category: "network", message: "boom" },
    });
    expect(result.success).toBe(false);
  });

  it("strips unknown fields silently (forward-compat reader)", () => {
    const parsed = historyRecordSchema.parse({ ...queryExample, future_field: 42 });
    expect(parsed).not.toHaveProperty("future_field");
  });

  it("rejects negative duration_ms", () => {
    expect(historyRecordSchema.safeParse({ ...queryExample, duration_ms: -1 }).success).toBe(false);
  });

  it("rejects non-integer duration_ms", () => {
    expect(historyRecordSchema.safeParse({ ...queryExample, duration_ms: 42.5 }).success).toBe(
      false,
    );
  });
});

describe("historyRecordSchema — kind: ai", () => {
  it("accepts the brief 0008 verbatim example", () => {
    expect(historyRecordSchema.safeParse(aiExample).success).toBe(true);
  });

  it("accepts intent suggest_sql", () => {
    expect(historyRecordSchema.safeParse({ ...aiExample, intent: "suggest_sql" }).success).toBe(
      true,
    );
  });

  it("rejects an unknown intent (-> drop on read)", () => {
    expect(historyRecordSchema.safeParse({ ...aiExample, intent: "summarize" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown status (-> drop on read)", () => {
    expect(historyRecordSchema.safeParse({ ...aiExample, status: "timeout" }).success).toBe(false);
  });

  // The cancel-is-not-an-error invariant: ADR-0026 Decision 12, carried
  // through to persistence by ADR-0027 Decision 5.
  it("accepts status cancelled with error null and a partial response", () => {
    const result = historyRecordSchema.safeParse({
      ...aiExample,
      status: "cancelled",
      response: "This query rea",
      error: null,
    });
    expect(result.success).toBe(true);
  });

  it("rejects status cancelled carrying an error envelope", () => {
    const result = historyRecordSchema.safeParse({
      ...aiExample,
      status: "cancelled",
      error: { category: "network", message: "aborted" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects error absent when status=error", () => {
    expect(
      historyRecordSchema.safeParse({ ...aiExample, status: "error", error: null }).success,
    ).toBe(false);
  });

  it("rejects error present when status=ok", () => {
    const result = historyRecordSchema.safeParse({
      ...aiExample,
      error: { category: "network", message: "boom" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts the three AI error categories", () => {
    for (const category of ["network", "provider", "configuration"]) {
      const result = historyRecordSchema.safeParse({
        ...aiExample,
        status: "error",
        error: { category, message: "boom" },
      });
      expect(result.success, `category ${category} should be accepted`).toBe(true);
    }
  });

  // "cancelled" is a status, not a category. A writer that puts it in
  // the envelope has misread the contract, and the schema says so.
  it("rejects cancelled as an error category", () => {
    const result = historyRecordSchema.safeParse({
      ...aiExample,
      status: "error",
      error: { category: "cancelled", message: "aborted" },
    });
    expect(result.success).toBe(false);
  });

  it("rejects a DB error category on an AI record", () => {
    const result = historyRecordSchema.safeParse({
      ...aiExample,
      status: "error",
      error: { category: "query", message: "boom" },
    });
    expect(result.success).toBe(false);
  });

  it("accepts null tokens (no Usage event before the terminal one)", () => {
    expect(
      historyRecordSchema.safeParse({ ...aiExample, tokens_in: null, tokens_out: null }).success,
    ).toBe(true);
  });

  it("rejects negative or non-integer token counts", () => {
    expect(historyRecordSchema.safeParse({ ...aiExample, tokens_in: -1 }).success).toBe(false);
    expect(historyRecordSchema.safeParse({ ...aiExample, tokens_out: 1.5 }).success).toBe(false);
  });

  it("accepts a conn string when the call had DB context", () => {
    expect(historyRecordSchema.safeParse({ ...aiExample, conn: "prod-pg" }).success).toBe(true);
  });

  // stop_reason is informational, so unknown values are tolerated
  // rather than dropping the record. Brief 0008 is explicit about the
  // asymmetry with intent and status.
  it("tolerates an unknown stop_reason instead of dropping the record", () => {
    expect(
      historyRecordSchema.safeParse({ ...aiExample, stop_reason: "other:weird" }).success,
    ).toBe(true);
    expect(historyRecordSchema.safeParse({ ...aiExample, stop_reason: "brand_new" }).success).toBe(
      true,
    );
    expect(historyRecordSchema.safeParse({ ...aiExample, stop_reason: null }).success).toBe(true);
  });

  it("rejects a non-string stop_reason", () => {
    expect(historyRecordSchema.safeParse({ ...aiExample, stop_reason: 7 }).success).toBe(false);
  });

  // The prompt is stored verbatim. This exists so a future "let's just
  // trim it" edit fails loudly — see brief 0008 § prompt.
  it("preserves prompt and response verbatim, including whitespace", () => {
    const prompt = "  SELECT 1;  \n\n";
    const result = historyRecordSchema.safeParse({ ...aiExample, prompt, response: prompt });
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === "ai") {
      expect(result.data.prompt).toBe(prompt);
      expect(result.data.response).toBe(prompt);
    }
  });

  it("accepts an empty response (cancelled before the first chunk)", () => {
    const result = historyRecordSchema.safeParse({
      ...aiExample,
      status: "cancelled",
      response: "",
      tokens_in: null,
      tokens_out: null,
      stop_reason: null,
      error: null,
    });
    expect(result.success).toBe(true);
  });
});

describe("v:1 back-compat", () => {
  it("historyRecordV1Schema still accepts the ADR-0017 §2 example", () => {
    expect(historyRecordV1Schema.safeParse(v1Example).success).toBe(true);
  });

  it("upgradeV1Record turns a v:1 record into the equivalent v:2 query record", () => {
    const upgraded = upgradeV1Record(historyRecordV1Schema.parse(v1Example));
    expect(upgraded).toEqual({
      v: 2,
      kind: "query",
      ts: v1Example.ts,
      conn: v1Example.conn,
      actor: v1Example.actor,
      sql: v1Example.sql,
      status: "ok",
      duration_ms: v1Example.duration_ms,
      rows: v1Example.rows,
      rows_affected: v1Example.rows_affected,
      error: null,
    });
  });

  it("the upgraded record validates against the v:2 union", () => {
    const upgraded = upgradeV1Record(historyRecordV1Schema.parse(v1Example));
    expect(historyRecordSchema.safeParse(upgraded).success).toBe(true);
  });

  it("carries a v:1 error envelope through the upgrade unchanged", () => {
    const errored = {
      ...v1Example,
      status: "error",
      rows: null,
      error: { category: "connection", message: "upstream gone" },
    };
    const upgraded = upgradeV1Record(historyRecordV1Schema.parse(errored));
    expect(upgraded.error).toEqual({ category: "connection", message: "upstream gone" });
    expect(historyRecordSchema.safeParse(upgraded).success).toBe(true);
  });

  it("the v:1 schema still rejects v:2 input (it is a legacy reader, not a union member)", () => {
    expect(historyRecordV1Schema.safeParse(queryExample).success).toBe(false);
  });
});

// ADR-0027 Decision 10 — the writer caps `prompt` and `response` at
// 64 KiB each. Mirrors desktop's `truncate_for_persistence`
// (crates/dbboard-ui/src/history.rs). The reference impl is the
// authority here, not the ADR prose: the ADR writes the marker as
// "… [truncated at 64 KiB]" with a leading ellipsis, but the shipped
// constant `AI_TEXT_TRUNCATED_MARKER` has a leading *space* and no
// ellipsis. Bytes on both sides have to match, so the constant wins.
//
// Note "at a UTF-8 char boundary" means a *code point* boundary, which
// is what Rust's `is_char_boundary` tests. Desktop will happily split a
// multi-code-point grapheme (a ZWJ emoji sequence); reproducing that
// faithfully matters more than being cleverer than the reference.
describe("truncateForPersistence (ADR-0027 Decision 10)", () => {
  const byteLength = (s: string): number => Buffer.byteLength(s, "utf8");

  it("returns short strings unchanged, with no marker appended", () => {
    expect(truncateForPersistence("SELECT 1")).toBe("SELECT 1");
    expect(truncateForPersistence("")).toBe("");
  });

  it("leaves a string of exactly the cap untouched (the bound is inclusive)", () => {
    const exact = "a".repeat(AI_TEXT_CAP_BYTES);
    expect(truncateForPersistence(exact)).toBe(exact);
  });

  it("truncates one byte past the cap and appends the marker", () => {
    const over = "a".repeat(AI_TEXT_CAP_BYTES + 1);
    const out = truncateForPersistence(over);

    expect(out.endsWith(AI_TEXT_TRUNCATED_MARKER)).toBe(true);
    expect(out.slice(0, -AI_TEXT_TRUNCATED_MARKER.length)).toBe("a".repeat(AI_TEXT_CAP_BYTES));
    expect(byteLength(out)).toBe(AI_TEXT_CAP_BYTES + byteLength(AI_TEXT_TRUNCATED_MARKER));
  });

  it("measures the cap in UTF-8 bytes, not UTF-16 code units", () => {
    // Each "あ" is 3 UTF-8 bytes but 1 JS code unit. A naive
    // `String.slice(0, CAP)` would keep ~3x too much text.
    const wide = "あ".repeat(AI_TEXT_CAP_BYTES); // 3 * CAP bytes
    const out = truncateForPersistence(wide);
    const body = out.slice(0, -AI_TEXT_TRUNCATED_MARKER.length);

    expect(byteLength(body)).toBeLessThanOrEqual(AI_TEXT_CAP_BYTES);
    expect(byteLength(body)).toBeGreaterThan(AI_TEXT_CAP_BYTES - 3);
  });

  it("never splits a code point, backing off to the boundary at-or-below the cap", () => {
    // Land a 3-byte character straddling the cap: CAP-2 filler bytes
    // means the next char occupies bytes CAP-2..CAP+1.
    const straddling = `${"a".repeat(AI_TEXT_CAP_BYTES - 2)}あtail`;
    const out = truncateForPersistence(straddling);
    const body = out.slice(0, -AI_TEXT_TRUNCATED_MARKER.length);

    // The straddling char is dropped whole rather than cut in half.
    expect(body).toBe("a".repeat(AI_TEXT_CAP_BYTES - 2));
    expect(body).not.toContain("�");
    expect(byteLength(body)).toBe(AI_TEXT_CAP_BYTES - 2);
  });

  it("keeps a surrogate pair intact (4-byte UTF-8, 2 JS code units)", () => {
    const straddling = `${"a".repeat(AI_TEXT_CAP_BYTES - 2)}😀tail`;
    const out = truncateForPersistence(straddling);
    const body = out.slice(0, -AI_TEXT_TRUNCATED_MARKER.length);

    expect(body).toBe("a".repeat(AI_TEXT_CAP_BYTES - 2));
    expect(body).not.toContain("�");
  });

  it("produces output the schema still accepts (the cap is a writer policy, not a bound the reader enforces)", () => {
    const record: HistoryAiRecord = {
      ...aiExample,
      prompt: truncateForPersistence("x".repeat(AI_TEXT_CAP_BYTES + 10)),
      response: truncateForPersistence("y".repeat(AI_TEXT_CAP_BYTES + 10)),
    };
    expect(historyRecordSchema.safeParse(record).success).toBe(true);
  });

  it("accepts an over-cap record on read — readers stay permissive", () => {
    // A file written by some other tool, or a future cap change, must
    // not make the record unreadable. Desktop's reader has no length
    // bound either.
    const record: HistoryAiRecord = { ...aiExample, prompt: "z".repeat(AI_TEXT_CAP_BYTES * 2) };
    expect(historyRecordSchema.safeParse(record).success).toBe(true);
  });
});

describe("HistoryRecord type", () => {
  it("narrows on kind", () => {
    const records: HistoryRecord[] = [queryExample, aiExample];
    const sqls = records.filter((r) => r.kind === "query").map((r) => r.sql);
    const prompts = records.filter((r) => r.kind === "ai").map((r) => r.prompt);
    expect(sqls).toEqual([queryExample.sql]);
    expect(prompts).toEqual([aiExample.prompt]);
  });
});
