import type { ConnectionRegistry } from "./connection-registry.port";

// Idempotent: deleting an unknown id is a 204 No Content. The contract
// has no body on success, so there's no need to surface "id was already
// gone" as a distinct outcome.
//
// Closes the adapter (if it exposes a `close` hook) before evicting from
// the registry. Errors raised by close are swallowed — the contract is
// "the record is gone" and a half-shut pool isn't worth bubbling up to
// the caller. Logged at info level so operators can still notice.
export class DeleteConnection {
  constructor(private readonly registry: ConnectionRegistry) {}

  async execute(id: string): Promise<void> {
    const record = this.registry.get(id);
    if (record?.adapter.close) {
      try {
        await record.adapter.close();
      } catch {
        // Pool already closed, or peer hung up. Either way, the contract
        // is honoured by removing the record below.
      }
    }
    this.registry.delete(id);
  }
}
