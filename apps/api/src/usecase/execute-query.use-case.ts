import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import type { QueryResult } from "../domain/values";
import type { ConnectionRegistry } from "./connection-registry.port";

// Centralises the dispatch logic the controller layer would otherwise
// duplicate. `connectionId` undefined => default adapter wired at
// bootstrap (0003 § "POST /query option (b)"). Specific id => look up
// in the registry; unknown id raises CapabilityError so the route
// surfaces as 404, matching the contract's "capability" envelope.
export class ExecuteQuery {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  async execute(sql: string, connectionId?: string): Promise<QueryResult> {
    if (connectionId === undefined) {
      return this.defaultAdapter.executeQuery(sql);
    }
    const record = this.registry.get(connectionId);
    if (!record) {
      throw new CapabilityError(`unknown connection: ${connectionId}`);
    }
    return record.adapter.executeQuery(sql);
  }
}
