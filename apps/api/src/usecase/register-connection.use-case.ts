import { randomUUID } from "node:crypto";
import { connectionPartsOf } from "../domain/connection-parts";
import { sshPartsOf } from "../domain/ssh";
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
//
// 0027 slice F narrows that from "the config is dropped" to "the credential
// is dropped". Keeping none of it also meant nothing could describe an
// existing connection, so no edit form could be prefilled (ADR-0080). The
// record now keeps what `connectionPartsOf` returns, which is a type with no
// password member — the config still goes nowhere near the record whole.
export class RegisterConnection {
  constructor(
    private readonly registry: ConnectionRegistry,
    private readonly adapterFactory: AdapterFactory,
    // Injected for deterministic tests; production uses node:crypto's
    // randomUUID, which is sufficiently unique for an in-memory store.
    private readonly newId: () => string = randomUUID,
  ) {}

  // Asynchronous since 0031 slice D: a connection fronted by an SSH tunnel
  // is not built until its forward is up. Nothing else here waits on I/O.
  async execute(input: RegisterConnectionInput): Promise<RegisterConnectionOutput> {
    const { label, driver, ...config } = input;
    const adapter = await this.adapterFactory.create(driver, config);
    const id = this.newId();
    // After `create`, deliberately: a config the factory rejects should raise
    // before anything about it is written down.
    const parts = connectionPartsOf(config);
    // Same rule, applied to the bastion: what is written down is where the
    // tunnel goes and which kind of credential it uses, never the credential
    // (0031 slice F).
    const ssh = sshPartsOf(config.ssh);
    this.registry.add({
      id,
      label,
      driver,
      adapter,
      ...(parts && { parts }),
      ...(ssh && { ssh }),
    });
    return { id };
  }
}
