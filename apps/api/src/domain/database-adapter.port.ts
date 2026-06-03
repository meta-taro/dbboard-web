import type { Capabilities, QueryResult, TableInfo } from "./values";

// The port every concrete adapter implements. NullAdapter (0003) and
// PostgresAdapter (0004) sit behind this; the controller layer never
// touches them directly — use cases do.
//
// `getId()` is the adapter-stable identifier surfaced by `GET
// /capabilities`. Pin to lowercase, stable across versions.
//
// `getCapabilities()` is synchronous and pure — Phase 2 ships every
// adapter with NULL_CAPABILITIES, later phases set flags alongside the
// endpoints that implement them.
export interface DatabaseAdapter {
  getId(): string;
  getCapabilities(): Capabilities;
  listTables(): Promise<TableInfo[]>;
  executeQuery(sql: string): Promise<QueryResult>;
}

// Provider token used by NestJS DI. Keeps the controller / use case
// wiring decoupled from the concrete adapter class.
export const DATABASE_ADAPTER = Symbol("DATABASE_ADAPTER");
