import { randomUUID } from "node:crypto";
import type { AdapterFactory } from "./adapter-factory.port";
import type { ConnectionRegistry } from "./connection-registry.port";

export interface RegisterConnectionInput {
  label: string;
  driver: string;
}

export interface RegisterConnectionOutput {
  id: string;
}

// Generates the id, asks the factory for the matching adapter, and
// stores both in the registry. The factory raises CapabilityError for
// unknown drivers — that propagates through ContractErrorFilter and
// the controller does not need to handle it explicitly.
export class RegisterConnection {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly adapterFactory: AdapterFactory,
    // Injected for deterministic tests; production uses node:crypto's
    // randomUUID, which is sufficiently unique for an in-memory store.
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(input: RegisterConnectionInput): RegisterConnectionOutput {
    const adapter = this.adapterFactory.create(input.driver);
    const id = this.newId();
    this.registry.add({ id, label: input.label, driver: input.driver, adapter });
    return { id };
  }
}
