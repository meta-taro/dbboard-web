import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { describe, expect, it } from "vitest";
import { TableSchemaQueryDto } from "./table-schema-query.dto";

function validate(payload: unknown) {
  const dto = plainToInstance(TableSchemaQueryDto, payload);
  return { dto, errors: validateSync(dto, { whitelist: true, forbidNonWhitelisted: false }) };
}

describe("TableSchemaQueryDto", () => {
  it("accepts a table with an explicit schema", () => {
    const { dto, errors } = validate({ table: "orders", schema: "sales" });
    expect(errors).toHaveLength(0);
    expect(dto).toMatchObject({ table: "orders", schema: "sales" });
  });

  it("accepts a table with no schema — the adapter resolves the default", () => {
    const { dto, errors } = validate({ table: "orders" });
    expect(errors).toHaveLength(0);
    expect(dto.schema).toBeUndefined();
  });

  it("rejects a missing table", () => {
    const { errors } = validate({ schema: "sales" });
    expect(errors.map((e) => e.property)).toEqual(["table"]);
  });

  it("rejects an empty table", () => {
    const { errors } = validate({ table: "" });
    expect(errors.map((e) => e.property)).toEqual(["table"]);
  });

  // `?schema=` is a lost value, not an omitted one.
  it("rejects a present-but-empty schema", () => {
    const { errors } = validate({ table: "orders", schema: "" });
    expect(errors.map((e) => e.property)).toEqual(["schema"]);
  });

  // Identifiers that would break a path segment are ordinary here.
  it("accepts identifiers containing path-hostile characters", () => {
    const { dto, errors } = validate({ table: 'we/ird?name#"quoted"' });
    expect(errors).toHaveLength(0);
    expect(dto.table).toBe('we/ird?name#"quoted"');
  });
});
