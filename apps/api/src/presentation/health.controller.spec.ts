import { describe, expect, it } from "vitest";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("returns { status: 'ok' } per the contract", () => {
    const controller = new HealthController();
    expect(controller.status()).toEqual({ status: "ok" });
  });
});
