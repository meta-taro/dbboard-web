import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, QueryError } from "../domain/errors";
import { ROW_CAP } from "../domain/limits";
import type { QueryResult } from "../domain/values";
import type { ConnectionRegistry } from "./connection-registry.port";

// Centralises the dispatch logic the controller layer would otherwise
// duplicate. `connectionId` undefined => default adapter wired at
// bootstrap (0003 § "POST /query option (b)"). Specific id => look up
// in the registry; unknown id raises CapabilityError so the route
// surfaces as 404, matching the contract's "capability" envelope.
//
// The 10,000-row cap (docs/api-contract.md) is enforced here, not in
// each adapter — keeping the contract guarantee in one place means a
// future driver can't accidentally ship a truncated grid.
export class ExecuteQuery {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  async execute(sql: string, connectionId?: string): Promise<QueryResult> {
    const result = await this.resolveAdapter(connectionId).executeQuery(sql);
    if (result.rows.length > ROW_CAP) {
      throw new QueryError(
        `result exceeds the 10,000-row cap (got ${result.rows.length.toLocaleString("en-US")})`,
      );
    }
    return result;
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
