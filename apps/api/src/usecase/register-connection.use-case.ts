import { randomUUID } from "node:crypto";
import { AdapterConfig, AdapterFactory } from "./adapter-factory.port";
import type { ConnectionRegistry } from "./connection-registry.port";

export interface RegisterConnectionInput extends AdapterConfig {
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
//
// Secrets-handling note: the connection-config fields (`password`,
// `connectionString`) are forwarded to the factory but are NOT copied
// onto the ConnectionRecord. They live solely inside the adapter
// instance — see `0004` § "The password / connection string is never
// logged" and the GET /connections leak test.
export class RegisterConnection {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly adapterFactory: AdapterFactory,
    // Injected for deterministic tests; production uses node:crypto's
    // randomUUID, which is sufficiently unique for an in-memory store.
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(input: RegisterConnectionInput): RegisterConnectionOutput {
    const { label, driver, ...config } = input;
    const adapter = this.adapterFactory.create(driver, config);
    const id = this.newId();
    this.registry.add({ id, label, driver, adapter });
    return { id };
  }
}
