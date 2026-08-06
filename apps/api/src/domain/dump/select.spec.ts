import { describe, expect, it } from "vitest";

import type { TableInfo } from "../values/table-info";
import { buildCount, buildSelectPage, CursorError } from "./select";

const users: TableInfo = { schema: "public", name: "users" };
const unqualified: TableInfo = { schema: null, name: "users" };

describe("buildSelectPage", () => {
  it("reads one unordered page when the table has no key", () => {
    expect(buildSelectPage(users, [], 1000, "postgres")).toBe(
      `SELECT * FROM "public"."users" LIMIT 1000`,
    );
  });

  it("orders by the key on the first page", () => {
    expect(buildSelectPage(users, ["id"], 1000, "postgres")).toBe(
      `SELECT * FROM "public"."users" ORDER BY "id" LIMIT 1000`,
    );
  });

  it("adds a keyset cursor from the second page on", () => {
    expect(buildSelectPage(users, ["id"], 1000, "postgres", [42])).toBe(
      `SELECT * FROM "public"."users" WHERE ("id") > ('42') ORDER BY "id" LIMIT 1000`,
    );
  });

  it("compares a composite key as a row value", () => {
    // (a, b) > (v1, v2) is the only correct composite-key cursor. Column-wise
    // ANDs either skip rows or repeat them.
    expect(buildSelectPage(users, ["tenant", "id"], 500, "postgres", ["acme", 7])).toBe(
      `SELECT * FROM "public"."users" WHERE ("tenant", "id") > ('acme', '7') ` +
        `ORDER BY "tenant", "id" LIMIT 500`,
    );
  });

  it("ignores a cursor when there is no key to order by", () => {
    expect(buildSelectPage(users, [], 10, "postgres", [1])).toBe(
      `SELECT * FROM "public"."users" LIMIT 10`,
    );
  });

  it("omits the schema when the table is unqualified", () => {
    expect(buildSelectPage(unqualified, [], 10, "postgres")).toBe(`SELECT * FROM "users" LIMIT 10`);
  });

  it("quotes key identifiers", () => {
    expect(buildSelectPage(unqualified, ['i"d'], 10, "postgres")).toBe(
      `SELECT * FROM "users" ORDER BY "i""d" LIMIT 10`,
    );
  });

  it("back-quotes the table, the ORDER BY and the cursor on MySQL", () => {
    // Three separate quoting call sites in one statement, which is why the
    // assertion is on the whole string rather than on the clause under test.
    expect(buildSelectPage(users, ["id"], 10, "mysql", [42])).toBe(
      "SELECT * FROM `public`.`users` WHERE (`id`) > ('42') ORDER BY `id` LIMIT 10",
    );
  });

  it("drops the schema on SQLite", () => {
    expect(buildSelectPage(users, ["id"], 10, "sqlite")).toBe(
      `SELECT * FROM "users" ORDER BY "id" LIMIT 10`,
    );
  });

  it("refuses a cursor whose arity does not match the key", () => {
    expect(() => buildSelectPage(users, ["a", "b"], 10, "postgres", [1])).toThrow(CursorError);
  });

  it("refuses a null cursor value rather than silently truncating the dump", () => {
    // ("id") > (NULL) is NULL, so the page comes back empty and every
    // remaining row of the table is quietly missing from the backup. A
    // declared primary key is never null, so reaching this means the read
    // disagreed with the schema — worth failing the table over.
    expect(() => buildSelectPage(users, ["id"], 10, "postgres", [null])).toThrow(CursorError);
  });
});

describe("buildCount", () => {
  it("counts the qualified table", () => {
    expect(buildCount(users, "postgres")).toBe(`SELECT COUNT(*) FROM "public"."users"`);
  });

  it("counts an unqualified table", () => {
    expect(buildCount(unqualified, "postgres")).toBe(`SELECT COUNT(*) FROM "users"`);
  });

  it("addresses the same table the paged reads do", () => {
    // The count and the reads must agree on the name, or a dialect fixed in
    // one and not the other sizes a table it then fails to read.
    expect(buildCount(users, "mysql")).toBe("SELECT COUNT(*) FROM `public`.`users`");
  });
});
