import type { DatabaseAdapter } from "../domain/database-adapter.port";

// A registered connection. `adapter` is the live instance the controllers
// dispatch to; `driver` and `label` are user-facing metadata returned by
// `GET /connections`. Secrets are stripped at the use case layer before
// the controller serializes the response.
export interface ConnectionRecord {
  id: string;
  label: string;
  driver: string;
  adapter: DatabaseAdapter;
}

// A flat store keyed by id. Production swap could be a persistent store
// (e.g. TOML-on-disk per desktop ADR-0013); the in-memory implementation
// in `infrastructure/in-memory-connection-registry.ts` is the Phase-2
// baseline.
export interface ConnectionRegistry {
  add(record: ConnectionRecord): void;
  list(): ConnectionRecord[];
  get(id: string): ConnectionRecord | undefined;
  delete(id: string): boolean;
}

export const CONNECTION_REGISTRY = Symbol("CONNECTION_REGISTRY");
