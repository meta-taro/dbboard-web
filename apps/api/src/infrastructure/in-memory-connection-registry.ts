import type { ConnectionRecord, ConnectionRegistry } from "../usecase/connection-registry.port";

// Map preserves insertion order — `GET /connections` returns the list in
// the order the user registered them, which is what the sidebar expects.
// State is lost on restart; persistence is a follow-up (see 0003 § Notes
// and desktop ADR-0013).
export class InMemoryConnectionRegistry implements ConnectionRegistry {
  private readonly store = new Map<string, ConnectionRecord>();

  add(record: ConnectionRecord): void {
    this.store.set(record.id, record);
  }

  list(): ConnectionRecord[] {
    return [...this.store.values()];
  }

  get(id: string): ConnectionRecord | undefined {
    return this.store.get(id);
  }

  delete(id: string): boolean {
    return this.store.delete(id);
  }
}
