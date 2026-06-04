import type { DatabaseAdapter } from "../domain/database-adapter.port";

// Constructs an adapter from a driver discriminator. RegisterConnection
// calls this; the use case stays driver-agnostic. 0003 supplies a
// StaticAdapterFactory that only knows "null"; 0004 extends it with
// "postgres". An unknown driver raises CapabilityError so the
// `POST /connections` route 404s rather than hard-erroring.
export interface AdapterFactory {
  create(driver: string): DatabaseAdapter;
}

export const ADAPTER_FACTORY = Symbol("ADAPTER_FACTORY");
