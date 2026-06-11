import { Injectable } from "@nestjs/common";
import type { HistoryRecord } from "../domain/history-record";
import type { HistoryStore } from "../usecase/history-store.port";

@Injectable()
export class InMemoryHistoryStore implements HistoryStore {
  private readonly records: HistoryRecord[] = [];

  record(record: HistoryRecord): Promise<void> {
    this.records.push(record);
    return Promise.resolve();
  }

  // Snapshot the array at iteration start so a writer landing during a
  // long-running export does not surface mid-stream and double-count.
  // Matches the desktop file-rotation guarantee where each export sees a
  // single sealed segment.
  async *iterate(): AsyncIterable<HistoryRecord> {
    const snapshot = [...this.records];
    for (const r of snapshot) yield r;
  }
}
