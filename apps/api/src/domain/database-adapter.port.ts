import type { Capabilities, QueryResult, TableInfo, TableSchema } from "./values";

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
  // Optional introspection hook (desktop ADR-0028). Optional rather than
  // required so adapters that cannot introspect — NullAdapter — need no
  // change: absence is the "not supported" signal, and DescribeTable turns
  // it into a CapabilityError. An adapter that implements this also sets
  // `has_describe_table` in getCapabilities(); the two travel together.
  describeTable?(table: TableInfo): Promise<TableSchema>;
  // Optional write hook (desktop ADR-0042 write-back, ADR-0051 restore).
  // Runs ONE statement that is expected to change the database, and returns
  // the number of rows it affected — 0 for DDL. Distinct from
  // `executeQuery`, which decodes a result set: a write has none, and the
  // affected count is the only thing worth reading back.
  //
  // Splitting a script into statements belongs to the caller, not here
  // (desktop puts it in `split_statements`, which arrives with restore).
  //
  // Optional for the same reason `describeTable` is: absence is the "not
  // supported" signal, so an adapter that must not write simply omits it
  // and UpdateRow turns that into a CapabilityError. An adapter that
  // implements this also sets `has_execute` in getCapabilities(); the two
  // travel together.
  execute?(sql: string): Promise<number>;
  // Optional DDL-reconstruction hook (desktop ADR-0049, dump). Returns the
  // `CREATE TABLE` — plus any owned sequences and standalone indexes —
  // needed to recreate `table` in an empty database, `;`-terminated and
  // ready to concatenate into a dump.
  //
  // Not derivable from `describeTable`: that answers what the columns are,
  // in the shape a grid needs, and drops constraints, indexes, defaults'
  // exact text, and sequence bounds. A dump needs all of them.
  //
  // Optional on the same terms as the hooks above — absence is the "not
  // supported" signal, and DumpDatabase turns it into a CapabilityError. An
  // adapter that implements this also sets `has_table_ddl`; the two travel
  // together.
  tableDdl?(table: TableInfo): Promise<string>;
  // Optional teardown hook. Implementations that hold network resources
  // (PostgresAdapter's pg.Pool) implement this so DELETE /connections
  // can release the sockets before evicting the registry record.
  // NullAdapter has nothing to close and omits it.
  close?(): Promise<void>;
}

// Provider token used by NestJS DI. Keeps the controller / use case
// wiring decoupled from the concrete adapter class.
export const DATABASE_ADAPTER = Symbol("DATABASE_ADAPTER");
