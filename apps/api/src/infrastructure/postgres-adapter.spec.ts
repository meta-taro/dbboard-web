import { describe, expect, it, vi } from "vitest";
import { ConnectionError, QueryError } from "../domain/errors";
import { NULL_CAPABILITIES } from "../domain/values";
import { PostgresAdapter, type PgQueryRunner } from "./postgres-adapter";

// The adapter takes a narrow `PgQueryRunner` instead of `pg.Pool` so
// these tests can inject a stub without any network involved. Production
// wraps a real `pg.Pool`, which satisfies the interface structurally.
function stubPool(overrides: Partial<PgQueryRunner> = {}): PgQueryRunner {
  return {
    query: vi.fn().mockResolvedValue({ rows: [], fields: [], rowCount: 0 }),
    end: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("PostgresAdapter", () => {
  it("reports id 'postgres' so /capabilities can identify it", () => {
    expect(new PostgresAdapter(stubPool()).getId()).toBe("postgres");
  });

  it("advertises every capability as false (Phase 2 baseline, per 0007)", () => {
    expect(new PostgresAdapter(stubPool()).getCapabilities()).toEqual(NULL_CAPABILITIES);
  });

  describe("listTables", () => {
    it("queries pg_catalog and filters out system schemas", async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [
          { schema: "public", name: "accounts" },
          { schema: "public", name: "users" },
        ],
        fields: [],
        rowCount: 2,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      const out = await adapter.listTables();
      expect(out).toEqual([
        { schema: "public", name: "accounts" },
        { schema: "public", name: "users" },
      ]);
      const sql = (query.mock.calls[0]?.[0] as { text: string }).text;
      expect(sql).toMatch(/pg_catalog\.pg_tables/);
      expect(sql).toMatch(/pg_catalog/);
      expect(sql).toMatch(/information_schema/);
    });

    it("returns an empty list when the catalog query yields no rows", async () => {
      const adapter = new PostgresAdapter(stubPool());
      await expect(adapter.listTables()).resolves.toEqual([]);
    });
  });

  describe("executeQuery", () => {
    it("uses rowMode 'array' and decodes every cell via the OID mapping", async () => {
      const query = vi.fn().mockResolvedValue({
        fields: [
          { name: "id", dataTypeID: 23 }, // int4
          { name: "name", dataTypeID: 25 }, // text
          { name: "active", dataTypeID: 16 }, // bool
        ],
        rows: [
          ["1", "Alice", "t"],
          ["2", "Bob", "f"],
        ],
        rowCount: 2,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      const out = await adapter.executeQuery("SELECT id, name, active FROM users");
      expect(out).toEqual({
        columns: [
          { name: "id", declared_type: "int4" },
          { name: "name", declared_type: "text" },
          { name: "active", declared_type: "bool" },
        ],
        rows: [
          [1, "Alice", 1],
          [2, "Bob", 0],
        ],
        rows_affected: 2,
      });
      expect((query.mock.calls[0]?.[0] as { rowMode: string }).rowMode).toBe("array");
    });

    it("declared_type is null when the OID is not in the catalog table", async () => {
      const query = vi.fn().mockResolvedValue({
        fields: [{ name: "exotic", dataTypeID: 9999 }],
        rows: [["x"]],
        rowCount: 1,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      const out = await adapter.executeQuery("SELECT 'x'::weird AS exotic");
      expect(out.columns).toEqual([{ name: "exotic", declared_type: null }]);
    });

    it("rows_affected falls back to 0 when pg reports null rowCount (e.g. DDL)", async () => {
      const query = vi.fn().mockResolvedValue({
        fields: [],
        rows: [],
        rowCount: null,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      const out = await adapter.executeQuery("CREATE TABLE t (id int)");
      expect(out.rows_affected).toBe(0);
    });

    it("translates pg SQLSTATE errors (42xxx etc.) into QueryError", async () => {
      // pg surfaces SQL faults with a 5-char SQLSTATE in `error.code`.
      // 42703 is "undefined column" — a caller fault, not a connection
      // problem, so it must map to QueryError → HTTP 400.
      const sqlError = Object.assign(new Error("column does not exist"), { code: "42703" });
      const adapter = new PostgresAdapter(stubPool({ query: vi.fn().mockRejectedValue(sqlError) }));
      await expect(adapter.executeQuery("SELECT bad FROM users")).rejects.toBeInstanceOf(
        QueryError,
      );
    });

    it("translates pg connection-class errors into ConnectionError", async () => {
      // Network-level errors have no SQLSTATE (or use Node's errno codes
      // like ECONNREFUSED). They must surface as ConnectionError → 502 so
      // the caller distinguishes "DB is down" from "your SQL is wrong".
      const connError = Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      });
      const adapter = new PostgresAdapter(
        stubPool({ query: vi.fn().mockRejectedValue(connError) }),
      );
      await expect(adapter.executeQuery("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
    });

    it("treats SQLSTATE class 08 ('connection exception') as ConnectionError", async () => {
      const e08 = Object.assign(new Error("connection failure"), { code: "08006" });
      const adapter = new PostgresAdapter(stubPool({ query: vi.fn().mockRejectedValue(e08) }));
      await expect(adapter.executeQuery("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
    });
  });

  describe("close", () => {
    it("ends the underlying pool", async () => {
      const end = vi.fn().mockResolvedValue(undefined);
      await new PostgresAdapter(stubPool({ end })).close();
      expect(end).toHaveBeenCalledOnce();
    });
  });
});
