import { describe, expect, it } from "vitest";

import { assembleTableDdl, TableDdlError, type TableDdlParts } from "./table-ddl";

function parts(overrides: Partial<TableDdlParts> = {}): TableDdlParts {
  return {
    schema: "public",
    table: "users",
    columns: [{ name: "id", type_name: "integer", not_null: true, default_expr: null }],
    constraints: [],
    indexes: [],
    sequences: [],
    ...overrides,
  };
}

describe("assembleTableDdl", () => {
  it("renders a one-column table", () => {
    expect(assembleTableDdl(parts())).toBe(
      'CREATE TABLE "public"."users" (\n    "id" integer NOT NULL\n);\n',
    );
  });

  it("renders a nullable column with a default verbatim", () => {
    // pg_get_expr output is already valid SQL and already quoted. Re-quoting
    // it would corrupt `nextval('s'::regclass)`.
    expect(
      assembleTableDdl(
        parts({
          columns: [
            {
              name: "n",
              type_name: "integer",
              not_null: false,
              default_expr: "nextval('s'::regclass)",
            },
          ],
        }),
      ),
    ).toBe(
      'CREATE TABLE "public"."users" (\n    "n" integer DEFAULT nextval(\'s\'::regclass)\n);\n',
    );
  });

  it("puts constraints inline after the columns", () => {
    expect(
      assembleTableDdl(
        parts({
          constraints: [
            { name: "users_pkey", def: "PRIMARY KEY (id)" },
            { name: "users_n_check", def: "CHECK ((n > 0))" },
          ],
        }),
      ),
    ).toBe(
      'CREATE TABLE "public"."users" (\n' +
        '    "id" integer NOT NULL,\n' +
        '    CONSTRAINT "users_pkey" PRIMARY KEY (id),\n' +
        '    CONSTRAINT "users_n_check" CHECK ((n > 0))\n' +
        ");\n",
    );
  });

  it("emits owned sequences ahead of the table so a nextval default resolves", () => {
    const ddl = assembleTableDdl(
      parts({
        sequences: [
          {
            schema: "public",
            name: "users_id_seq",
            type_name: "bigint",
            start: "1",
            increment: "1",
            min_value: "1",
            max_value: "9223372036854775807",
            cache: "1",
            cycle: false,
          },
        ],
      }),
    );
    expect(ddl.startsWith('CREATE SEQUENCE "public"."users_id_seq" AS bigint START WITH 1 ')).toBe(
      true,
    );
    expect(ddl).toContain("MAXVALUE 9223372036854775807");
    expect(ddl.indexOf("CREATE SEQUENCE")).toBeLessThan(ddl.indexOf("CREATE TABLE"));
  });

  it("keeps bigint sequence bounds exact", () => {
    // 9223372036854775807 is past Number.MAX_SAFE_INTEGER. Decoding it as a
    // number would render 9223372036854775808, which Postgres rejects as out
    // of range for bigint — so these travel as strings.
    const ddl = assembleTableDdl(
      parts({
        sequences: [
          {
            schema: "public",
            name: "s",
            type_name: "bigint",
            start: "1",
            increment: "1",
            min_value: "-9223372036854775808",
            max_value: "9223372036854775807",
            cache: "1",
            cycle: true,
          },
        ],
      }),
    );
    expect(ddl).toContain("MINVALUE -9223372036854775808 MAXVALUE 9223372036854775807");
    expect(ddl).toContain("CACHE 1 CYCLE;");
  });

  it("refuses a non-integral sequence bound rather than interpolating it", () => {
    expect(() =>
      assembleTableDdl(
        parts({
          sequences: [
            {
              schema: "public",
              name: "s",
              type_name: "bigint",
              start: "1); DROP TABLE users; --",
              increment: "1",
              min_value: "1",
              max_value: "10",
              cache: "1",
              cycle: false,
            },
          ],
        }),
      ),
    ).toThrow(TableDdlError);
  });

  it("appends standalone indexes verbatim", () => {
    expect(
      assembleTableDdl(
        parts({ indexes: ["CREATE INDEX users_n_idx ON public.users USING btree (n)"] }),
      ),
    ).toContain("CREATE INDEX users_n_idx ON public.users USING btree (n);\n");
  });

  it("quotes identifiers and doubles an embedded double quote", () => {
    expect(
      assembleTableDdl(
        parts({
          schema: 'sch"ema',
          table: 'ta"ble',
          columns: [{ name: 'co"l', type_name: "text", not_null: false, default_expr: null }],
        }),
      ),
    ).toBe('CREATE TABLE "sch""ema"."ta""ble" (\n    "co""l" text\n);\n');
  });

  it("omits absent sections rather than erroring — Aurora DSQL has no sequences", () => {
    const ddl = assembleTableDdl(parts());
    expect(ddl).not.toContain("CREATE SEQUENCE");
    expect(ddl).not.toContain("CREATE INDEX");
  });

  it("refuses a table with no columns", () => {
    expect(() => assembleTableDdl(parts({ columns: [] }))).toThrow(TableDdlError);
  });
});
