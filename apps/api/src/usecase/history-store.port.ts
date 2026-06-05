import type { HistoryRecord } from "../domain/history-record";

// Port for query-history persistence (ticket 0009, mirrors desktop
// ADR-0017). The schema (`HistoryRecord`) is the cross-repo contract;
// storage, rotation, and retention are deliberately left to the
// adapter. In-memory is the default for development and tests; a
// Postgres-backed adapter is a follow-up ticket once a per-tenant
// store is needed.
//
// `iterate()` returns an AsyncIterable so the export endpoint can
// stream NDJSON without first materialising the whole table in memory.

export interface HistoryStore {
  record(record: HistoryRecord): Promise<void>;
  iterate(): AsyncIterable<HistoryRecord>;
}

export const HISTORY_STORE = Symbol("HISTORY_STORE");
