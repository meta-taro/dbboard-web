import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NULL_CAPABILITIES } from "../domain/values";
import { GetCapabilities } from "./get-capabilities.use-case";

describe("GetCapabilities", () => {
  it("composes the adapter id with its capability flags", () => {
    const adapter: DatabaseAdapter = {
      getId: () => "null",
      getCapabilities: () => NULL_CAPABILITIES,
      listTables: async () => [],
      executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
    };
    expect(new GetCapabilities(adapter).execute()).toEqual({
      id: "null",
      capabilities: NULL_CAPABILITIES,
    });
  });
});
