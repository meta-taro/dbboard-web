import { Inject, Injectable } from "@nestjs/common";
import { HISTORY_STORE, type HistoryStore } from "./history-store.port";

// Stream-friendly NDJSON encoder for the operator-only history egress
// endpoint. ADR-0017 §8 keeps history off the standard wire contract
// (docs/api-contract.md); this use case exists so the export route can
// pipe one JSON object per line without first materialising the full
// table in memory.
//
// Each yielded chunk encodes exactly one record terminated by `\n`,
// keeping `curl … | jq -c .` round-trip-clean. The store-side snapshot
// guarantee from InMemoryHistoryStore.iterate() means records landing
// mid-export are deferred to the next export call.
@Injectable()
export class ExportHistory {
  constructor(@Inject(HISTORY_STORE) private readonly store: HistoryStore) {}

  async *stream(): AsyncIterable<string> {
    for await (const record of this.store.iterate()) {
      yield `${JSON.stringify(record)}\n`;
    }
  }
}
