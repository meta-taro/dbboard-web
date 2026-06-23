import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { historyRecordSchema, type HistoryRecord } from "../src/domain/history-record";
import { InMemoryHistoryStore } from "../src/infrastructure/in-memory-history-store";
import { ExportHistory } from "../src/usecase/export-history.use-case";

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
const LOCAL_FIXTURE_PATH = path.resolve(__dirname, "fixtures/local-history.jsonl");

const KNOWN_RECORD_KEYS = new Set([
  "v",
  "ts",
  "conn",
  "actor",
  "sql",
  "status",
  "duration_ms",
  "rows",
  "rows_affected",
  "error",
]);

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

    it("every line validates against historyRecordSchema (Zod strips unknown fields silently)", () => {
      for (const line of lines) {
        const result = historyRecordSchema.safeParse(line.parsed);
        expect(result.success, `line did not validate: ${line.raw}`).toBe(true);
      }
    });

    it("known-key-only lines round-trip byte-identically via JSON.stringify(JSON.parse(line))", () => {
      // Per ADR-0017 §2 the canonical form is what `serde_json::to_string`
      // produces — declaration-order fields, no whitespace. V8's
      // JSON.stringify reproduces that for any object whose keys are in
      // the same insertion order, which the Zod-parsed record is by
      // construction.
      for (const line of lines) {
        if (line.unknownKeys.length > 0) continue;
        const reparsed = JSON.stringify(JSON.parse(line.raw));
        expect(reparsed, `canonical-form mismatch on line: ${line.raw}`).toBe(line.raw);
      }
    });

    it("known-key-only lines re-export byte-identically via ExportHistory.stream()", async () => {
      for (const line of lines) {
        if (line.unknownKeys.length > 0) continue;
        const parsed = historyRecordSchema.parse(line.parsed);
        const emitted = await reExportLine(parsed);
        expect(emitted, `re-export mismatch on line: ${line.raw}`).toBe(`${line.raw}\n`);
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
        const parsed = historyRecordSchema.parse(line.parsed);
        // Sanity: the parsed object has no unknown keys (Zod strip).
        for (const unknown of line.unknownKeys) {
          expect(parsed as Record<string, unknown>).not.toHaveProperty(unknown);
        }
        // Re-exported bytes deliberately diverge from the source line:
        // the unknown field is gone, so the emitted line is the same
        // record minus that field. The source line, however, must still
        // parse identically through Zod, proving the strip path is
        // silent (no error, no log, no counter bump).
        const emitted = await reExportLine(parsed);
        expect(emitted.endsWith("\n")).toBe(true);
        for (const unknown of line.unknownKeys) {
          expect(emitted).not.toContain(`"${unknown}"`);
        }
      }
    });
  },
);

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

  it("every line validates against historyRecordSchema", () => {
    for (const line of lines) {
      const result = historyRecordSchema.safeParse(line.parsed);
      expect(result.success, `local line did not validate: ${line.raw}`).toBe(true);
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
