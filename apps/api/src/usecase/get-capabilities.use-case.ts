import type { DatabaseAdapter } from "../domain/database-adapter.port";
import type { Capabilities } from "../domain/values";

export interface GetCapabilitiesOutput {
  id: string;
  capabilities: Capabilities;
}

export class GetCapabilities {
  constructor(private readonly adapter: DatabaseAdapter) {}

  execute(): GetCapabilitiesOutput {
    return {
      id: this.adapter.getId(),
      capabilities: this.adapter.getCapabilities(),
    };
  }
}
