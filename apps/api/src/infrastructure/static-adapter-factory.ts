import { CapabilityError } from "../domain/errors";
import type { AdapterConfig, AdapterFactory } from "../usecase/adapter-factory.port";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NullAdapter } from "./null-adapter";
import { createPostgresAdapter } from "./postgres-adapter";

// 0004 adds the "postgres" branch. Each driver-branch validates the
// shape of `config` it needs; the factory itself stays oblivious. An
// unknown driver raises CapabilityError so POST /connections lands as
// 404 rather than a hard 500.
export class StaticAdapterFactory implements AdapterFactory {
  create(driver: string, config: AdapterConfig): DatabaseAdapter {
    switch (driver) {
      case "null":
        return new NullAdapter();
      case "postgres":
        return createPostgresAdapter(config);
      default:
        throw new CapabilityError(`unknown driver: ${driver}`);
    }
  }
}
