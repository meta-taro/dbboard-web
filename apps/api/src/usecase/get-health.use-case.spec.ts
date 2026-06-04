import { describe, expect, it } from "vitest";
import { GetHealth } from "./get-health.use-case";

describe("GetHealth", () => {
  it("returns the contract's liveness payload", () => {
    expect(new GetHealth().execute()).toEqual({ status: "ok" });
  });
});
