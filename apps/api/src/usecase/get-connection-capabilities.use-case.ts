import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import type { ConnectionRegistry } from "./connection-registry.port";
import type { GetCapabilitiesOutput } from "./get-capabilities.use-case";

// Connection-scoped sibling of GetCapabilities, and a prerequisite for any
// capability the UI branches on.
//
// GET /capabilities resolves DATABASE_ADAPTER — the bootstrap adapter,
// which is NullAdapter with every flag false. That is honest but useless
// to a client, which is never talking to it: the adapters that can do
// anything are the ones the registry holds per connection. The desktop
// does not have this split (one backend at a time, swapped in place per
// ADR-0020), so the flags there need no addressing.
//
// Synchronous because getCapabilities() is: the port declares it pure and
// non-blocking, and no adapter may consult the network to answer it.
export class GetConnectionCapabilities {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  execute(connectionId?: string): GetCapabilitiesOutput {
    const adapter = this.resolveAdapter(connectionId);
    return { id: adapter.getId(), capabilities: adapter.getCapabilities() };
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
