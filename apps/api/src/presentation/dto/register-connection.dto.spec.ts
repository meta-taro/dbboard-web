import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { RegisterConnectionDto } from "./register-connection.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(RegisterConnectionDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("RegisterConnectionDto", () => {
  it("accepts a well-formed { label, driver } body", () => {
    const { dto, errors } = validate({ label: "Local null", driver: "null" });
    expect(errors).toHaveLength(0);
    expect(dto).toEqual({ label: "Local null", driver: "null" });
  });

  it("rejects when label is missing", () => {
    const { errors } = validate({ driver: "null" });
    expect(errors.map((e) => e.property)).toContain("label");
  });

  it("rejects when driver is missing", () => {
    const { errors } = validate({ label: "x" });
    expect(errors.map((e) => e.property)).toContain("driver");
  });
});
