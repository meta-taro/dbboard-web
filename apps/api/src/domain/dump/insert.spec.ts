import { describe, expect, it } from "vitest";

import type { TableInfo } from "../values/table-info";
import { buildInsert } from "./insert";

const users: TableInfo = { schema: "public", name: "users" };
const unqualified: TableInfo = { schema: null, name: "users" };

describe("buildInsert", () => {
  it("builds one multi-row INSERT", () => {
    expect(
      buildInsert(
        users,
        ["id", "name"],
        [
          [1, "ada"],
          [2, "grace"],
        ],
      ),
    ).toBe(`INSERT INTO "public"."users" ("id", "name") VALUES ('1', 'ada'), ('2', 'grace');`);
  });

  it("omits the schema when the table is unqualified", () => {
    expect(buildInsert(unqualified, ["id"], [[1]])).toBe(
      `INSERT INTO "users" ("id") VALUES ('1');`,
    );
  });

  it("quotes identifiers and doubles an embedded double quote", () => {
    const odd: TableInfo = { schema: null, name: 'we"ird' };
    expect(buildInsert(odd, ['co"l'], [[1]])).toBe(`INSERT INTO "we""ird" ("co""l") VALUES ('1');`);
  });

  it("returns null when there are no rows", () => {
    expect(buildInsert(users, ["id"], [])).toBeNull();
  });

  it("returns null when there are no columns", () => {
    expect(buildInsert(users, [], [[]])).toBeNull();
  });

  it("pads a short row with NULL rather than throwing", () => {
    expect(buildInsert(users, ["id", "name"], [[1]])).toBe(
      `INSERT INTO "public"."users" ("id", "name") VALUES ('1', NULL);`,
    );
  });

  it("ignores cells past the declared column count", () => {
    expect(buildInsert(users, ["id"], [[1, "extra"]])).toBe(
      `INSERT INTO "public"."users" ("id") VALUES ('1');`,
    );
  });
});
