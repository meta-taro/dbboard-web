import type { ConnectionParts } from "../domain/connection-parts";
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
  // Where this connection points, minus the credential (0027 slice F). The
  // record used to remember nothing at all, which kept the password safe and
  // also made an edit form impossible — ADR-0080's blocker exactly. A type
  // with no password member resolves both at once.
  //
  // Optional because "no parts" is a real state, not a missing value: a
  // `null`-driver connection has no address to describe.
  parts?: ConnectionParts;
}

// A flat store keyed by id. Production swap could be a persistent store
// (e.g. TOML-on-disk per desktop ADR-0013); the in-memory implementation
// in `infrastructure/in-memory-connection-registry.ts` is the Phase-2
// baseline.
export interface ConnectionRegistry {
  // An upsert. Adding an id that is already present replaces the record and
  // keeps its position in `list()` — sidebar order is registration order,
  // and an edited connection should not move (0027 slice G).
  add(record: ConnectionRecord): void;
  list(): ConnectionRecord[];
  get(id: string): ConnectionRecord | undefined;
  delete(id: string): boolean;
}

export const CONNECTION_REGISTRY = Symbol("CONNECTION_REGISTRY");
