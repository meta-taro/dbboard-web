import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { QueryRequestDto } from "./query-request.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(QueryRequestDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("QueryRequestDto", () => {
  it("accepts a well-formed { sql: string } body", () => {
    const { dto, errors } = validate({ sql: "SELECT 1" });
    expect(errors).toHaveLength(0);
    expect(dto.sql).toBe("SELECT 1");
  });

  it("rejects a missing sql field — semantic 422 territory", () => {
    const { errors } = validate({});
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("sql");
  });

  it("rejects a non-string sql — semantic 422 territory", () => {
    const { errors } = validate({ sql: 123 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("sql");
  });

  it("rejects an empty string sql — semantic 422 territory", () => {
    const { errors } = validate({ sql: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("sql");
  });
});
