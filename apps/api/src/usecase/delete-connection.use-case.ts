import type { ConnectionRegistry } from "./connection-registry.port";

// Idempotent: deleting an unknown id is a 204 No Content. The contract
// has no body on success, so there's no need to surface "id was already
// gone" as a distinct outcome.
export class DeleteConnection {
  constructor(private readonly registry: ConnectionRegistry) {}

  execute(id: string): void {
    this.registry.delete(id);
  }
}
