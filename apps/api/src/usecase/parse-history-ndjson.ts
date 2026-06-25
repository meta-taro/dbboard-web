import { historyRecordSchema, type HistoryRecord } from "../domain/history-record";

// Pure NDJSON reader for the per-record history schema (ADR-0017 §6,
// ticket 0021). Closes the last unticked Phase 5 DoD bullet by giving
// callers a typed counter that distinguishes *why* a record was dropped:
// unknown protocol version vs. unknown status enum vs. malformed JSON
// vs. generic schema failure. Zod alone would conflate every drop into
// the last bucket; pre-schema attribution preserves the operator signal.
//
// No I/O, no DI, no logging — `stats` is a return value so callers (a
// future ingest endpoint, a CLI re-import script, conformance tests)
// choose how to surface it.

export interface HistoryReaderStats {
  accepted: number;
  dropped_invalid_json: number;
  dropped_unknown_v: number;
  dropped_unknown_status: number;
  dropped_invalid_shape: number;
}

export interface HistoryReaderResult {
  records: HistoryRecord[];
  stats: HistoryReaderStats;
}

const KNOWN_STATUSES = new Set(["ok", "error"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function classifyTypedFields(
  parsed: unknown,
): { kind: "unknown_v" } | { kind: "unknown_status" } | { kind: "passthrough" } {
  if (!isPlainObject(parsed)) {
    return { kind: "passthrough" };
  }
  if ("v" in parsed && parsed.v !== 1) {
    return { kind: "unknown_v" };
  }
  if (
    "status" in parsed &&
    typeof parsed.status === "string" &&
    !KNOWN_STATUSES.has(parsed.status)
  ) {
    return { kind: "unknown_status" };
  }
  return { kind: "passthrough" };
}

export function parseHistoryNdjson(bytes: string): HistoryReaderResult {
  const records: HistoryRecord[] = [];
  const stats: HistoryReaderStats = {
    accepted: 0,
    dropped_invalid_json: 0,
    dropped_unknown_v: 0,
    dropped_unknown_status: 0,
    dropped_invalid_shape: 0,
  };

  if (bytes.length === 0) {
    return { records, stats };
  }

  const lines = bytes.split("\n");
  // LF-terminated files yield an empty trailing element; don't count it
  // as a malformed-JSON drop.
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }

  for (const line of lines) {
    // Empty / whitespace-only lines are noise (e.g., double-LF between
    // records); not records, not malformed JSON. Skip silently.
    if (line.trim() === "") {
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      stats.dropped_invalid_json++;
      continue;
    }

    const classification = classifyTypedFields(parsed);
    if (classification.kind === "unknown_v") {
      stats.dropped_unknown_v++;
      continue;
    }
    if (classification.kind === "unknown_status") {
      stats.dropped_unknown_status++;
      continue;
    }

    const result = historyRecordSchema.safeParse(parsed);
    if (!result.success) {
      stats.dropped_invalid_shape++;
      continue;
    }

    records.push(result.data);
    stats.accepted++;
  }

  return { records, stats };
}
