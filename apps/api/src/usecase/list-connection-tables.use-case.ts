import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import type { TableInfo } from "../domain/values";
import type { ConnectionRegistry } from "./connection-registry.port";

export interface ListConnectionTablesOutput {
  tables: TableInfo[];
}

// Connection-scoped sibling of ListTables. The web app registers
// adapters per-connection at runtime (unlike the desktop's single
// startup-bound backend), so the schema-browser surface needs a route
// that resolves the live adapter via the registry. `connectionId`
// undefined falls back to the default adapter for parity with
// ExecuteQuery, even though the only caller (GET /connections/:id/tables)
// always supplies one.
export class ListConnectionTables {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  async execute(connectionId?: string): Promise<ListConnectionTablesOutput> {
    return { tables: await this.resolveAdapter(connectionId).listTables() };
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
