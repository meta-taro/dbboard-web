import { CapabilityError } from "../domain/errors";
import type { AdapterFactory } from "../usecase/adapter-factory.port";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NullAdapter } from "./null-adapter";

// 0003 ships with the null driver only. 0004 adds the "postgres" case
// by extending this switch; nothing else in the system needs to learn
// about the new driver because the use case and registry already
// dispatch by id.
export class StaticAdapterFactory implements AdapterFactory {
  create(driver: string): DatabaseAdapter {
    switch (driver) {
      case "null":
        return new NullAdapter();
      default:
        throw new CapabilityError(`unknown driver: ${driver}`);
    }
  }
}
