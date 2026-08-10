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

  // ADR-0028 Decision 9 (full half) — the per-table descriptions the
  // panel prefetched, a verbatim round-trip of what
  // GET /connections/:id/table-schema answered.
  describe("full_schema", () => {
    const column = (over: Record<string, unknown> = {}) => ({
      name: "id",
      declared_type: "integer",
      nullable: false,
      primary_key: true,
      ordinal: 1,
      default_value: null,
      ...over,
    });

    const table = (over: Record<string, unknown> = {}) => ({
      table: { schema: "public", name: "users" },
      columns: [column()],
      primary_key: ["id"],
      ...over,
    });

    it("accepts a described table alongside the terse list", () => {
      const { dto, errors } = validate({
        prompt: "x",
        schema: [{ schema: "public", name: "users" }],
        full_schema: [table()],
      });
      expect(errors).toHaveLength(0);
      expect(dto.full_schema?.[0]?.table?.name).toBe("users");
      expect(dto.full_schema?.[0]?.columns?.[0]?.declared_type).toBe("integer");
      expect(dto.full_schema?.[0]?.primary_key).toStrictEqual(["id"]);
    });

    it("accepts a null declared_type and a null default", () => {
      const { dto, errors } = validate({
        prompt: "x",
        full_schema: [table({ columns: [column({ declared_type: null, default_value: null })] })],
      });
      expect(errors).toHaveLength(0);
      expect(dto.full_schema?.[0]?.columns?.[0]?.declared_type).toBeNull();
    });

    it("accepts a table with no columns and no key", () => {
      const { errors } = validate({
        prompt: "x",
        full_schema: [table({ columns: [], primary_key: [] })],
      });
      expect(errors).toHaveLength(0);
    });

    it("leaves full_schema undefined when omitted", () => {
      const { dto, errors } = validate({ prompt: "x" });
      expect(errors).toHaveLength(0);
      expect(dto.full_schema).toBeUndefined();
    });

    it("accepts an empty list — the fan-out came back with nothing usable", () => {
      const { dto, errors } = validate({ prompt: "x", full_schema: [] });
      expect(errors).toHaveLength(0);
      expect(dto.full_schema).toStrictEqual([]);
    });

    it("rejects a non-array full_schema", () => {
      const { errors } = validate({ prompt: "x", full_schema: "users" });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("full_schema");
    });

    it("rejects an entry with no table", () => {
      const { errors } = validate({ prompt: "x", full_schema: [{ columns: [], primary_key: [] }] });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("full_schema");
    });

    it("rejects a column with no name", () => {
      const { errors } = validate({
        prompt: "x",
        full_schema: [table({ columns: [column({ name: undefined })] })],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("full_schema");
    });

    it("rejects a non-boolean nullable", () => {
      // Strings are the interesting case: `"false"` is truthy, so a lax
      // DTO would render a NOT NULL column as nullable and the prompt
      // would state the opposite of the schema.
      const { errors } = validate({
        prompt: "x",
        full_schema: [table({ columns: [column({ nullable: "false" })] })],
      });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("full_schema");
    });

    it("rejects a primary_key that is not a list of strings", () => {
      const { errors } = validate({ prompt: "x", full_schema: [table({ primary_key: [7] })] });
      expect(errors).toHaveLength(1);
      expect(errors[0]?.property).toBe("full_schema");
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
