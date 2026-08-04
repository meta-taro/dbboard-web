import {
  historyRecordSchema,
  historyRecordV1Schema,
  upgradeV1Record,
  type HistoryRecord,
} from "../domain/history-record";

// Pure NDJSON reader for the per-record history schema (ADR-0027,
// tickets 0021 and 0023). Gives callers a typed counter that
// distinguishes *why* a record was dropped: unknown protocol version vs.
// unknown kind vs. unknown status enum vs. unknown intent vs. malformed
// JSON vs. generic schema failure. Zod alone would conflate every drop
// into the last bucket; pre-schema attribution preserves the operator
// signal.
//
// Reads both v:1 and v:2. A v:1 record is upgraded to the equivalent
// v:2 `kind: "query"` record on the way through — see ticket 0023 §
// "The one design decision this ticket has to make" for why the reader
// upgrades rather than preserving v:1 bytes.
//
// No I/O, no DI, no logging — `stats` is a return value so callers (a
// future ingest endpoint, a CLI re-import script, conformance tests)
// choose how to surface it.

export interface HistoryReaderStats {
  accepted: number;
  dropped_invalid_json: number;
  dropped_unknown_v: number;
  dropped_unknown_kind: number;
  dropped_unknown_status: number;
  dropped_unknown_intent: number;
  dropped_invalid_shape: number;
}

export interface HistoryReaderResult {
  records: HistoryRecord[];
  stats: HistoryReaderStats;
}

const KNOWN_VERSIONS = new Set([1, 2]);
const KNOWN_KINDS = new Set(["query", "ai"]);
// Statuses are per-kind, not global: `cancelled` is meaningful for an AI
// call and out of vocabulary for a query.
const STATUSES_BY_KIND: Record<string, Set<string>> = {
  query: new Set(["ok", "error"]),
  ai: new Set(["ok", "error", "cancelled"]),
};
const KNOWN_INTENTS = new Set(["explain", "suggest_sql"]);

type Classification =
  | { drop: "unknown_v" | "unknown_kind" | "unknown_status" | "unknown_intent" }
  | { drop: null };

const PASSTHROUGH: Classification = { drop: null };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Attribute the drop reason for the fields whose *vocabulary* this
 * reader may not know, before Zod gets a chance to flatten them all
 * into one bucket.
 *
 * Anything this returns `{ drop: null }` for is left to the schema —
 * including a missing discriminator, which is a malformed record rather
 * than an unknown kind.
 */
function classifyTypedFields(parsed: unknown): Classification {
  if (!isPlainObject(parsed)) {
    return PASSTHROUGH;
  }
  if ("v" in parsed && typeof parsed.v === "number" && !KNOWN_VERSIONS.has(parsed.v)) {
    return { drop: "unknown_v" };
  }

  // v:1 has no discriminator; it is a query record by definition.
  const kind = parsed.v === 2 && typeof parsed.kind === "string" ? parsed.kind : "query";
  if (parsed.v === 2 && typeof parsed.kind === "string" && !KNOWN_KINDS.has(kind)) {
    return { drop: "unknown_kind" };
  }

  const statuses = STATUSES_BY_KIND[kind];
  if (statuses && typeof parsed.status === "string" && !statuses.has(parsed.status)) {
    return { drop: "unknown_status" };
  }

  if (kind === "ai" && typeof parsed.intent === "string" && !KNOWN_INTENTS.has(parsed.intent)) {
    return { drop: "unknown_intent" };
  }

  return PASSTHROUGH;
}

export function parseHistoryNdjson(bytes: string): HistoryReaderResult {
  const records: HistoryRecord[] = [];
  const stats: HistoryReaderStats = {
    accepted: 0,
    dropped_invalid_json: 0,
    dropped_unknown_v: 0,
    dropped_unknown_kind: 0,
    dropped_unknown_status: 0,
    dropped_unknown_intent: 0,
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
    if (classification.drop !== null) {
      stats[`dropped_${classification.drop}`]++;
      continue;
    }

    const record = parseRecord(parsed);
    if (record === null) {
      stats.dropped_invalid_shape++;
      continue;
    }

    records.push(record);
    stats.accepted++;
  }

  return { records, stats };
}

function parseRecord(parsed: unknown): HistoryRecord | null {
  if (isPlainObject(parsed) && parsed.v === 1) {
    const legacy = historyRecordV1Schema.safeParse(parsed);
    return legacy.success ? upgradeV1Record(legacy.data) : null;
  }
  const result = historyRecordSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
