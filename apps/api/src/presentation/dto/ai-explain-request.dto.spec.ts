import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { AiExplainRequestDto } from "./ai-explain-request.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(AiExplainRequestDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("AiExplainRequestDto", () => {
  it("accepts { sql: string } with dialect omitted", () => {
    const { dto, errors } = validate({ sql: "SELECT 1" });
    expect(errors).toHaveLength(0);
    expect(dto.sql).toBe("SELECT 1");
    expect(dto.dialect).toBeUndefined();
  });

  it("accepts { sql, dialect } when both provided", () => {
    const { dto, errors } = validate({ sql: "SELECT 1", dialect: "postgres" });
    expect(errors).toHaveLength(0);
    expect(dto.dialect).toBe("postgres");
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

  it("rejects a non-string dialect when provided — keeps the prompt shape predictable", () => {
    const { errors } = validate({ sql: "SELECT 1", dialect: 42 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("dialect");
  });
});
