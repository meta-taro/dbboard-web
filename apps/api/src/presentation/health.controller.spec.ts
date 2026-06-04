import { describe, expect, it } from "vitest";
import { GetHealth } from "../usecase/get-health.use-case";
import { HealthController } from "./health.controller";

describe("HealthController", () => {
  it("delegates to GetHealth and returns { status: 'ok' } per the contract", () => {
    const controller = new HealthController(new GetHealth());
    expect(controller.status()).toEqual({ status: "ok" });
  });
});
