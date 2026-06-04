import { describe, expect, it } from "vitest";
import { CapabilityError } from "../domain/errors";
import { NULL_CAPABILITIES } from "../domain/values";
import { NullAdapter } from "./null-adapter";

describe("NullAdapter", () => {
  it("reports id 'null' so /capabilities can identify it", () => {
    expect(new NullAdapter().getId()).toBe("null");
  });

  it("advertises every capability as false (Phase 2 baseline)", () => {
    expect(new NullAdapter().getCapabilities()).toEqual(NULL_CAPABILITIES);
  });

  it("returns an empty table list", async () => {
    await expect(new NullAdapter().listTables()).resolves.toEqual([]);
  });

  it("throws CapabilityError on executeQuery so /query lands at 404", async () => {
    // The "no database is wired" condition is a capability gap, not a
    // SQL fault — distinct from QueryError so the UI can grey out the
    // editor instead of showing a SQL error.
    await expect(new NullAdapter().executeQuery("SELECT 1")).rejects.toBeInstanceOf(
      CapabilityError,
    );
  });
});
