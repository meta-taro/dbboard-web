// This is the first DTO with nested objects, so it is the first spec that
// needs the metadata `@Type()` reads. Production loads the polyfill in
// main.ts; a unit spec has no entrypoint to inherit it from.
import "reflect-metadata";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { UpdateRowDto } from "./update-row.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(UpdateRowDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

const body = {
  table: "users",
  schema: "public",
  key: [{ column: "id", value: 7 }],
  edits: [{ column: "email", value: "new@example.com" }],
};

// The DTO validates *shape*; the domain validates *meaning*. An empty key or
// an empty edit list is well-formed JSON that asks for something impossible,
// and write-back.ts already refuses each with a message worth reading — so
// they are deliberately not re-gated here (see the accepting tests below).
describe("UpdateRowDto", () => {
  it("accepts a well-formed single-column update", () => {
    const { dto, errors } = validate(body);
    expect(errors).toHaveLength(0);
    expect(dto.table).toBe("users");
    expect(dto.key[0]).toMatchObject({ column: "id", value: 7 });
    expect(dto.edits[0]).toMatchObject({ column: "email", value: "new@example.com" });
  });

  it("accepts a table with no schema — the adapter resolves the default", () => {
    const { dto, errors } = validate({ ...body, schema: undefined });
    expect(errors).toHaveLength(0);
    expect(dto.schema).toBeUndefined();
  });

  it("rejects a missing table", () => {
    const { errors } = validate({ ...body, table: undefined });
    expect(errors.map((e) => e.property)).toEqual(["table"]);
  });

  it("rejects a present-but-empty schema", () => {
    const { errors } = validate({ ...body, schema: "" });
    expect(errors.map((e) => e.property)).toEqual(["schema"]);
  });

  it("rejects a key that is not an array", () => {
    const { errors } = validate({ ...body, key: { column: "id", value: 7 } });
    expect(errors.map((e) => e.property)).toEqual(["key"]);
  });

  it("rejects an edit with no column name", () => {
    const { errors } = validate({ ...body, edits: [{ value: "x" }] });
    expect(errors.map((e) => e.property)).toEqual(["edits"]);
  });

  describe("identity values", () => {
    // A key column carries the row's original value, whatever its type —
    // the WHERE clause encodes each by its real type rather than round-
    // tripping through text.
    it.each([
      ["a number", 7],
      ["text", "abc"],
      ["null", null],
    ])("accepts %s", (_label, value) => {
      const { dto, errors } = validate({ ...body, key: [{ column: "id", value }] });
      expect(errors).toHaveLength(0);
      expect(dto.key[0].value).toBe(value);
    });

    // Not refused here: write-back.ts refuses a blob identity by name
    // ("unsupported (blob) value"), which reads better than a generic
    // validation failure on `key.0.value`.
    it("lets a blob identity through to the domain's refusal", () => {
      const { dto, errors } = validate({
        ...body,
        key: [{ column: "id", value: { $blob: "AA==" } }],
      });
      expect(errors).toHaveLength(0);
      expect(dto.key[0].value).toEqual({ $blob: "AA==" });
    });

    it("rejects a key column with no name", () => {
      const { errors } = validate({ ...body, key: [{ value: 7 }] });
      expect(errors.map((e) => e.property)).toEqual(["key"]);
    });
  });

  describe("edited values", () => {
    // The editor produces text and only text, plus one explicit NULL.
    it("accepts an explicit null — the request for SQL NULL", () => {
      const { dto, errors } = validate({ ...body, edits: [{ column: "email", value: null }] });
      expect(errors).toHaveLength(0);
      expect(dto.edits[0].value).toBeNull();
    });

    it("accepts an omitted value, which also means NULL", () => {
      const { dto, errors } = validate({ ...body, edits: [{ column: "email" }] });
      expect(errors).toHaveLength(0);
      expect(dto.edits[0].value).toBeUndefined();
    });

    // Empty string is a value, not an absence: `''` and NULL are different
    // rows, and the editor can produce either on purpose.
    it("accepts an empty string", () => {
      const { dto, errors } = validate({ ...body, edits: [{ column: "email", value: "" }] });
      expect(errors).toHaveLength(0);
      expect(dto.edits[0].value).toBe("");
    });

    // A number here would be the client skipping the editor's own coercion;
    // the plan says text, so text is what the route accepts.
    it("rejects a non-text edited value", () => {
      const { errors } = validate({ ...body, edits: [{ column: "n", value: 7 }] });
      expect(errors.map((e) => e.property)).toEqual(["edits"]);
    });
  });
});
