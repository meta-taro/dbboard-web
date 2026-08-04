import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { HistoryRecord } from "../src/domain/history-record";
import { InMemoryHistoryStore } from "../src/infrastructure/in-memory-history-store";
import { ExportHistory } from "../src/usecase/export-history.use-case";
import { parseHistoryNdjson } from "../src/usecase/parse-history-ndjson";

// Cross-implementation byte-equivalence harness for the query-history
// schema mirror (issue 0018, closes the Phase 5 acceptance line in
// .claude/roadmap.md). The fixture under test is bytes emitted by
// desktop's `serde_json::to_string(&RecordWire)` (reference impl
// `dbboard@72cb165:crates/dbboard-ui/src/history.rs`). The fixture
// itself is shipped by the desktop agent per the brief at
// .claude/handoff/2026-06-23-history-fixture-emit-outgoing.md and the
// provenance ADR in .claude/decisions.md ("2026-06-23 — Desktop
// history.jsonl fixture provenance + drift policy").
//
// Until the bytes land, this file uses `describe.skipIf(...)` keyed on
// the fixture's presence, so the suite is silently inert and `pnpm test`
// stays green. Dropping the file at the path below turns the
// assertions on with no code change.

const FIXTURE_PATH = path.resolve(__dirname, "fixtures/desktop-history.jsonl");
const V2_FIXTURE_PATH = path.resolve(__dirname, "fixtures/desktop-history-v2.jsonl");
const LOCAL_FIXTURE_PATH = path.resolve(__dirname, "fixtures/local-history.jsonl");

// Union of both v:2 kinds plus the v:1 field set, because a fixture may
// hold any of them and "unknown key" here means "not part of any
// schema" — the forward-compat probe, not a kind mismatch.
const KNOWN_RECORD_KEYS = new Set([
  "v",
  "kind",
  "ts",
  "conn",
  "actor",
  "status",
  "duration_ms",
  "error",
  // query
  "sql",
  "rows",
  "rows_affected",
  // ai
  "intent",
  "prompt",
  "response",
  "tokens_in",
  "tokens_out",
  "provider",
  "model",
  "stop_reason",
]);

// A v:1 line is upgraded on read (ticket 0023), so its re-exported bytes
// are the source line with exactly one substitution: the version bumped
// and the discriminator inserted. Stating the transform as a literal
// string edit is the point — it asserts that *no other byte moved*.
function expectedReExport(raw: string): string {
  return raw.startsWith('{"v":1,') ? `{"v":2,"kind":"query",${raw.slice('{"v":1,'.length)}` : raw;
}

interface FixtureLine {
  raw: string;
  parsed: Record<string, unknown>;
  unknownKeys: string[];
}

function splitFixture(bytes: string): string[] {
  // Desktop guarantees LF terminators and a trailing newline; we split
  // on LF and drop the trailing empty element so each entry is a full
  // JSON document with no stray newline.
  const lines = bytes.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function loadFixture(filePath: string): FixtureLine[] {
  const bytes = readFileSync(filePath, "utf8");
  return splitFixture(bytes).map((raw) => {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const unknownKeys = Object.keys(parsed).filter((k) => !KNOWN_RECORD_KEYS.has(k));
    return { raw, parsed, unknownKeys };
  });
}

// The reader is the only supported entry point now that v:1 and v:2 both
// have to be accepted; going straight to `historyRecordSchema` would skip
// the upgrade and reject every legacy line.
function parseOneOrThrow(raw: string): HistoryRecord {
  const { records } = parseHistoryNdjson(`${raw}\n`);
  if (records.length !== 1) throw new Error(`line was not accepted by the reader: ${raw}`);
  return records[0];
}

async function reExportLine(parsed: HistoryRecord): Promise<string> {
  const store = new InMemoryHistoryStore();
  await store.record(parsed);
  const exporter = new ExportHistory(store);
  let out = "";
  for await (const chunk of exporter.stream()) out += chunk;
  return out;
}

// Committed fixture — bytes from desktop's RecordWire serialiser per
// the outgoing handoff brief. Skipped (and therefore inert) until the
// file is committed at apps/api/test/fixtures/desktop-history.jsonl.
describe.skipIf(!existsSync(FIXTURE_PATH))(
  "desktop history.jsonl round-trip (committed fixture)",
  () => {
    const lines = existsSync(FIXTURE_PATH) ? loadFixture(FIXTURE_PATH) : [];

    it("fixture is non-empty (sanity check on the committed bytes)", () => {
      expect(lines.length).toBeGreaterThan(0);
    });

    it("every line parses as JSON and the file is LF-terminated", () => {
      // Reload raw to assert the LF-terminator invariant explicitly.
      const bytes = readFileSync(FIXTURE_PATH, "utf8");
      expect(bytes.endsWith("\n")).toBe(true);
      expect(bytes.includes("\r")).toBe(false);
      for (const line of lines) {
        expect(() => JSON.parse(line.raw)).not.toThrow();
      }
    });

    it("every line is accepted by the reader with no drops attributed", () => {
      const { records, stats } = parseHistoryNdjson(readFileSync(FIXTURE_PATH, "utf8"));
      expect(records).toHaveLength(lines.length);
      expect(stats).toStrictEqual({
        accepted: lines.length,
        dropped_invalid_json: 0,
        dropped_unknown_v: 0,
        dropped_unknown_kind: 0,
        dropped_unknown_status: 0,
        dropped_unknown_intent: 0,
        dropped_invalid_shape: 0,
      });
    });

    it("known-key-only lines round-trip byte-identically via JSON.stringify(JSON.parse(line))", () => {
      // Per ADR-0017 §2 the canonical form is what `serde_json::to_string`
      // produces — declaration-order fields, no whitespace. V8's
      // JSON.stringify reproduces that for any object whose keys are in
      // the same insertion order, which the parsed record is by
      // construction. This assertion is about the *fixture's* own bytes
      // and so is unaffected by the v:1 → v:2 upgrade below.
      for (const line of lines) {
        if (line.unknownKeys.length > 0) continue;
        const reparsed = JSON.stringify(JSON.parse(line.raw));
        expect(reparsed, `canonical-form mismatch on line: ${line.raw}`).toBe(line.raw);
      }
    });

    it("known-key-only lines re-export as canonical v:2 with only the header rewritten", async () => {
      // Byte identity no longer holds for a v:1 fixture: the reader
      // upgrades on the way in (ticket 0023), so the emitted line is v:2.
      // Everything *else* must still match byte-for-byte.
      for (const line of lines) {
        if (line.unknownKeys.length > 0) continue;
        const parsed = parseOneOrThrow(line.raw);
        const emitted = await reExportLine(parsed);
        expect(emitted, `re-export mismatch on line: ${line.raw}`).toBe(
          `${expectedReExport(line.raw)}\n`,
        );
      }
    });

    it("forward-compat lines validate, drop unknown fields on re-emit, and never throw", async () => {
      const forwardCompat = lines.filter((l) => l.unknownKeys.length > 0);
      // The fixture contract in the handoff brief mandates at least one
      // forward-compat line; absence of one means the fixture was
      // regenerated without the brief's case 5 coverage.
      expect(
        forwardCompat.length,
        "fixture is missing the forward-compat record (brief §case 5)",
      ).toBeGreaterThan(0);

      for (const line of forwardCompat) {
        const parsed = parseOneOrThrow(line.raw);
        // Sanity: the parsed object has no unknown keys (Zod strip).
        for (const unknown of line.unknownKeys) {
          expect(parsed as Record<string, unknown>).not.toHaveProperty(unknown);
        }
        // Re-exported bytes deliberately diverge from the source line:
        // the unknown field is gone, so the emitted line is the same
        // record minus that field. The source line, however, must still
        // read without error, proving the strip path is silent (no throw,
        // no log, no counter bump).
        const emitted = await reExportLine(parsed);
        expect(emitted.endsWith("\n")).toBe(true);
        for (const unknown of line.unknownKeys) {
          expect(emitted).not.toContain(`"${unknown}"`);
        }
      }
    });
  },
);

// v:2 fixture — bytes from desktop's v:2 writer, emitted by
// `cargo run --example emit_history_fixture -p dbboard-ui -- --output <path>`
// per brief 0008 § Handoff procedure step 3. Unlike the v:1 file above,
// these lines need no upgrade on read, so the round-trip assertion is
// true byte identity rather than a stated transform.
//
// Coverage note: the emitter currently produces exactly ONE `kind: "ai"`
// line, and it is `status: "ok"`. There is no desktop-emitted `error` or
// `cancelled` AI record to test against. `cancelled` is the gap that
// matters — web never *writes* that status (no abort path; see
// record-history.use-case.ts) so its read support is otherwise only
// exercised against web-authored objects, which is exactly the circular
// validation this fixture exists to break. Raised back to desktop per
// brief 0008 § Notes; tracked in .claude/issues/0023-history-v2-mirror.md.
describe.skipIf(!existsSync(V2_FIXTURE_PATH))("desktop history.jsonl round-trip (v:2)", () => {
  const lines = existsSync(V2_FIXTURE_PATH) ? loadFixture(V2_FIXTURE_PATH) : [];

  it("is LF-terminated with no CR (the --output flag bypasses PowerShell re-encoding)", () => {
    const bytes = readFileSync(V2_FIXTURE_PATH, "utf8");
    expect(lines.length).toBeGreaterThan(0);
    expect(bytes.endsWith("\n")).toBe(true);
    expect(bytes.includes("\r")).toBe(false);
  });

  it("every line is accepted by the reader with no drops attributed", () => {
    const { records, stats } = parseHistoryNdjson(readFileSync(V2_FIXTURE_PATH, "utf8"));
    expect(records).toHaveLength(lines.length);
    expect(stats).toStrictEqual({
      accepted: lines.length,
      dropped_invalid_json: 0,
      dropped_unknown_v: 0,
      dropped_unknown_kind: 0,
      dropped_unknown_status: 0,
      dropped_unknown_intent: 0,
      dropped_invalid_shape: 0,
    });
  });

  it("covers both kinds — a regenerated fixture that lost the AI record fails here", () => {
    const { records } = parseHistoryNdjson(readFileSync(V2_FIXTURE_PATH, "utf8"));
    const kinds = new Set(records.map((r) => r.kind));
    expect(kinds).toEqual(new Set(["query", "ai"]));
    expect(records.every((r) => r.v === 2)).toBe(true);
  });

  it("known-key-only lines re-export byte-identically", async () => {
    for (const line of lines) {
      if (line.unknownKeys.length > 0) continue;
      const emitted = await reExportLine(parseOneOrThrow(line.raw));
      expect(emitted, `re-export mismatch on line: ${line.raw}`).toBe(`${line.raw}\n`);
    }
  });

  it("strips unknown fields on re-emit without dropping the record", async () => {
    const forwardCompat = lines.filter((l) => l.unknownKeys.length > 0);
    expect(
      forwardCompat.length,
      "v:2 fixture is missing the forward-compat record",
    ).toBeGreaterThan(0);

    for (const line of forwardCompat) {
      const emitted = await reExportLine(parseOneOrThrow(line.raw));
      for (const unknown of line.unknownKeys) {
        expect(emitted).not.toContain(`"${unknown}"`);
      }
    }
  });
});

// Optional ad-hoc local fixture — gitignored slot for the maintainer
// to drop in an interactively-extracted history.jsonl from
// %APPDATA%\dbboard\dbboard\config\history.jsonl (Windows) or the
// `directories::ProjectDirs` equivalent on macOS / Linux. Gated by both
// presence of the file AND DBBOARD_LOCAL_HISTORY_FIXTURE=1 so a
// forgotten file from a prior session doesn't surprise the next test
// run.
const LOCAL_ENABLED =
  process.env.DBBOARD_LOCAL_HISTORY_FIXTURE === "1" && existsSync(LOCAL_FIXTURE_PATH);

describe.skipIf(!LOCAL_ENABLED)("desktop history.jsonl round-trip (local ad-hoc fixture)", () => {
  const lines = LOCAL_ENABLED ? loadFixture(LOCAL_FIXTURE_PATH) : [];

  it("every line is accepted by the reader", () => {
    for (const line of lines) {
      expect(
        () => parseOneOrThrow(line.raw),
        `local line did not validate: ${line.raw}`,
      ).not.toThrow();
    }
  });

  it("known-key-only lines round-trip byte-identically", () => {
    for (const line of lines) {
      if (line.unknownKeys.length > 0) continue;
      const reparsed = JSON.stringify(JSON.parse(line.raw));
      expect(reparsed, `local canonical-form mismatch: ${line.raw}`).toBe(line.raw);
    }
  });
});
