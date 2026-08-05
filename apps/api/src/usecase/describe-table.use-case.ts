import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import type { TableInfo, TableSchema } from "../domain/values";
import type { ConnectionRegistry } from "./connection-registry.port";

// Connection-scoped introspection (desktop ADR-0028). Resolves the live
// adapter the same way ListConnectionTables does — the web app binds
// adapters per connection at runtime, unlike the desktop's single
// startup-bound backend.
//
// Two distinct failures both surface as CapabilityError (404): the
// connection is unknown, or the adapter cannot describe. Callers that need
// to distinguish them read the message; the schema browser does not — it
// falls back to the `LIMIT 0` probe either way.
export class DescribeTable {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  async execute(connectionId: string | undefined, table: TableInfo): Promise<TableSchema> {
    const adapter = this.resolveAdapter(connectionId);
    if (!adapter.describeTable) {
      throw new CapabilityError(`adapter cannot describe tables: ${adapter.getId()}`);
    }
    return adapter.describeTable(table);
  }

  private resolveAdapter(connectionId: string | undefined): DatabaseAdapter {
    if (connectionId === undefined) return this.defaultAdapter;
    const record = this.registry.get(connectionId);
    if (!record) {
      throw new CapabilityError(`unknown connection: ${connectionId}`);
    }
    return record.adapter;
  }
}
