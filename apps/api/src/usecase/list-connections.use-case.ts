import type { ConnectionRegistry } from "./connection-registry.port";

export interface ConnectionView {
  id: string;
  label: string;
  driver: string;
}

export interface ListConnectionsOutput {
  connections: ConnectionView[];
}

// Projects the registry records into the public view shape. Drops the
// adapter instance and any driver-specific config (which 0004 will carry
// secrets in) — `GET /connections` must never expose a password or a
// full connection string.
export class ListConnections {
  constructor(private readonly registry: ConnectionRegistry) {}

  execute(): ListConnectionsOutput {
    return {
      connections: this.registry.list().map(({ id, label, driver }) => ({ id, label, driver })),
    };
  }
}
