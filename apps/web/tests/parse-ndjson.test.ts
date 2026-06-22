import { describe, expect, it } from "vitest";
import { parseNdjson } from "../app/composables/internal/parse-ndjson";

const identity = <T>(v: unknown): T => v as T;

describe("parseNdjson", () => {
  it("returns an empty array for empty input", () => {
    expect(parseNdjson<unknown>("", identity)).toEqual([]);
  });

  it("returns an empty array for whitespace-only input", () => {
    expect(parseNdjson<unknown>("   \n\n  \r\n", identity)).toEqual([]);
  });

  it("parses a single line", () => {
    expect(parseNdjson<{ a: number }>('{"a":1}', identity)).toEqual([{ a: 1 }]);
  });

  it("parses multiple newline-separated records in order", () => {
    const text = '{"a":1}\n{"a":2}\n{"a":3}';
    expect(parseNdjson<{ a: number }>(text, identity)).toEqual([{ a: 1 }, { a: 2 }, { a: 3 }]);
  });

  it("accepts CRLF line endings (Windows-emitted egress)", () => {
    const text = '{"a":1}\r\n{"a":2}\r\n';
    expect(parseNdjson<{ a: number }>(text, identity)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("drops trailing empty lines silently", () => {
    const text = '{"a":1}\n\n\n';
    expect(parseNdjson<{ a: number }>(text, identity)).toEqual([{ a: 1 }]);
  });

  it("silently skips lines that fail JSON.parse", () => {
    const text = '{"a":1}\nnot json\n{"a":2}';
    expect(parseNdjson<{ a: number }>(text, identity)).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it("drops lines for which validate() returns null", () => {
    const text = '{"a":1}\n{"b":2}\n{"a":3}';
    const onlyA = (v: unknown): { a: number } | null => {
      if (v && typeof v === "object" && "a" in v && typeof (v as { a: unknown }).a === "number") {
        return v as { a: number };
      }
      return null;
    };
    expect(parseNdjson<{ a: number }>(text, onlyA)).toEqual([{ a: 1 }, { a: 3 }]);
  });

  it("round-trips a fixture written by JSON.stringify per line", () => {
    const records = [
      { sql: "SELECT 1", duration_ms: 5 },
      { sql: "SELECT 2", duration_ms: 8 },
    ];
    const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n";
    expect(parseNdjson<(typeof records)[number]>(text, identity)).toEqual(records);
  });
});
