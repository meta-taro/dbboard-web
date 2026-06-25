import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { AiSuggestRequestDto } from "./ai-suggest-request.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(AiSuggestRequestDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("AiSuggestRequestDto", () => {
  it("accepts { prompt: string } with dialect omitted", () => {
    const { dto, errors } = validate({ prompt: "list active users" });
    expect(errors).toHaveLength(0);
    expect(dto.prompt).toBe("list active users");
    expect(dto.dialect).toBeUndefined();
  });

  it("accepts { prompt, dialect } when both provided", () => {
    const { dto, errors } = validate({ prompt: "list active users", dialect: "sqlite" });
    expect(errors).toHaveLength(0);
    expect(dto.dialect).toBe("sqlite");
  });

  it("rejects a missing prompt field — semantic 422 territory", () => {
    const { errors } = validate({});
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("prompt");
  });

  it("rejects a non-string prompt — semantic 422 territory", () => {
    const { errors } = validate({ prompt: 123 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("prompt");
  });

  it("rejects an empty string prompt — semantic 422 territory", () => {
    const { errors } = validate({ prompt: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("prompt");
  });

  it("rejects a non-string dialect when provided", () => {
    const { errors } = validate({ prompt: "x", dialect: 42 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("dialect");
  });
});
