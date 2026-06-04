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

  it("accepts a postgres body with a connectionString", () => {
    const { dto, errors } = validate({
      label: "Prod",
      driver: "postgres",
      connectionString: "postgresql://u:p@host:5432/db",
    });
    expect(errors).toHaveLength(0);
    expect(dto.connectionString).toBe("postgresql://u:p@host:5432/db");
  });

  it("accepts a postgres body with split fields", () => {
    const { dto, errors } = validate({
      label: "Local",
      driver: "postgres",
      host: "localhost",
      port: 5432,
      database: "app",
      user: "u",
      password: "p",
    });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({
      host: "localhost",
      port: 5432,
      database: "app",
      user: "u",
      password: "p",
    });
  });

  it("rejects port out of TCP range", () => {
    const { errors } = validate({ label: "x", driver: "postgres", host: "h", port: 70000 });
    expect(errors.map((e) => e.property)).toContain("port");
  });

  it("rejects non-string connectionString", () => {
    const { errors } = validate({ label: "x", driver: "postgres", connectionString: 42 });
    expect(errors.map((e) => e.property)).toContain("connectionString");
  });
});
