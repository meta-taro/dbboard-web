import type { AdapterFactory } from "./adapter-factory.port";

export interface ListDriversOutput {
  drivers: string[];
}

/**
 * What this build can connect with, so a chooser can offer those and only
 * those (0027 slice E).
 *
 * Deliberately not folded into `GET /capabilities`: that surface is mirrored
 * from desktop (`docs/api-contract.md`) and answers what the *current*
 * adapter can do, which is a different question from what adapters exist.
 */
export class ListDrivers {
  constructor(private readonly factory: AdapterFactory) {}

  execute(): ListDriversOutput {
    return { drivers: [...this.factory.supported()] };
  }
}
