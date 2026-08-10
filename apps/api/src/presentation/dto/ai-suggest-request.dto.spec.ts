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

  // ADR-0028 Decision 8 (terse half) — the table list the panel already
  // has for the connection it is mounted on.
  describe("schema", () => {
    it("accepts a list of qualified and bare table names", () => {
      const { dto, errors } = validate({
        prompt: "recent orders",
        schema: [
          { schema: "public", name: "users" },
          { schema: null, name: "orders" },
        ],
      });
      expect(errors).toHaveLength(0);
      expect(dto.schema).toHaveLength(2);
      expect(dto.schema?.[0]?.name).toBe("users");
      expect(dto.schema?.[1]?.schema).toBeNull();
    });

    it("accepts an empty list — 'introspected, found none' is a real answer", () => {
      const { dto, errors } = validate({ prompt: "x", schema: [] });
      expect(errors).toHaveLength(0);
      expect(dto.schema).toStrictEqual([]);
    });

    it("leaves schema undefined when omitted, which is not the same as empty", () => {
      const { dto, errors } = validate({ prompt: "x" });
      expect(errors).toHaveLength(0);
      expect(dto.schema).toBeUndefined();
    });

    it("rejects a non-array schema", () => {
      const { errors } = validate({ prompt: "x", schema: "users" });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("schema");
    });

    it("rejects an entry with no name", () => {
      const { errors } = validate({ prompt: "x", schema: [{ schema: "public" }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("schema");
    });

    it("rejects an entry whose schema is neither a string nor null", () => {
      const { errors } = validate({ prompt: "x", schema: [{ schema: 7, name: "users" }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("schema");
    });
  });

  // 0032 slice B. `provider` names which configured provider answers.
  // The DTO only checks it is a non-empty string — whether that name
  // exists is the registry's question, and answering it twice would mean
  // two places deciding what is configured.
  it("accepts an optional provider name", () => {
    const { dto, errors } = validate({ prompt: "all users", provider: "opus" });
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBe("opus");
  });

  it("leaves provider undefined when omitted, so the default answers", () => {
    const { dto, errors } = validate({ prompt: "all users" });
    expect(errors).toHaveLength(0);
    expect(dto.provider).toBeUndefined();
  });

  it("rejects a non-string provider", () => {
    const { errors } = validate({ prompt: "all users", provider: 7 });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("provider");
  });

  it("rejects an empty provider rather than reading it as unset", () => {
    const { errors } = validate({ prompt: "all users", provider: "" });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.property).toBe("provider");
  });
});
