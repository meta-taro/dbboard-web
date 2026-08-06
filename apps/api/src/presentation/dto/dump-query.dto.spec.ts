import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { DumpQueryDto } from "./dump-query.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(DumpQueryDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("DumpQueryDto", () => {
  it("accepts an absent confirm — the unconfirmed first request", () => {
    const { dto, errors } = validate({});
    expect(errors).toHaveLength(0);
    expect(dto.confirm).toBeUndefined();
  });

  it("accepts confirm=true", () => {
    const { dto, errors } = validate({ confirm: "true" });
    expect(errors).toHaveLength(0);
    expect(dto.confirm).toBe("true");
  });

  it("accepts an explicit confirm=false", () => {
    const { errors } = validate({ confirm: "false" });
    expect(errors).toHaveLength(0);
  });

  // Reading these as "not confirmed" would replay the size refusal and
  // leave the caller blaming the database for a typo in the query string.
  it.each(["1", "yes", "TRUE", ""])("rejects %o rather than reading it as false", (confirm) => {
    const { errors } = validate({ confirm });
    expect(errors.map((e) => e.property)).toEqual(["confirm"]);
  });
});
