import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import { GetCapabilities } from "../usecase/get-capabilities.use-case";
import { CapabilitiesController } from "./capabilities.controller";

function adapter(): DatabaseAdapter {
  return {
    getId: () => "null",
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

describe("CapabilitiesController", () => {
  it("returns the { id, capabilities } envelope the contract specifies", () => {
    const controller = new CapabilitiesController(new GetCapabilities(adapter()));
    expect(controller.get()).toEqual({ id: "null", capabilities: NULL_CAPABILITIES });
  });
});
