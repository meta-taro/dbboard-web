import { describe, expect, it, vi } from "vitest";
import { ConnectionError, QueryError } from "../domain/errors";
import { NULL_CAPABILITIES } from "../domain/values";
import {
  attachIdleClientErrorHandler,
  createPostgresAdapter,
  PostgresAdapter,
  type PgQueryRunner,
} from "./postgres-adapter";

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

  // Every other flag stays false — a flag is set by the rung that gives it
  // something to promise: has_describe_table by 0026, has_execute by 0028,
  // has_table_ddl by 0029.
  it("advertises has_describe_table, has_execute and has_table_ddl, and nothing else", () => {
    expect(new PostgresAdapter(stubPool()).getCapabilities()).toEqual({
      ...NULL_CAPABILITIES,
      has_describe_table: true,
      has_execute: true,
      has_table_ddl: true,
    });
  });

  describe("execute (write path, desktop ADR-0042)", () => {
    it("sends the statement and returns the engine's affected-row count", async () => {
      const query = vi.fn().mockResolvedValue({ rows: [], fields: [], rowCount: 1 });
      const adapter = new PostgresAdapter(stubPool({ query }));

      const affected = await adapter.execute(`UPDATE "users" SET "a" = 'b' WHERE "id" = 1`);

      expect(affected).toBe(1);
      expect(query).toHaveBeenCalledWith({ text: `UPDATE "users" SET "a" = 'b' WHERE "id" = 1` });
    });

    it("does not bind parameters, so the statement stays on the simple protocol", async () => {
      // The statement arrives fully escaped from `buildUpdateSql`. Adding a
      // `values` array here would move pg to the extended protocol, which is
      // where a binary result format becomes expressible (ADR-0070).
      const query = vi.fn().mockResolvedValue({ rows: [], fields: [], rowCount: 1 });
      await new PostgresAdapter(stubPool({ query })).execute("UPDATE t SET a = 1");
      expect(query.mock.calls[0]?.[0]).not.toHaveProperty("values");
    });

    it("reports zero rather than inventing a count when pg reports none", async () => {
      // `rowCount` is null for statements that affect nothing measurable.
      // Zero is the truthful answer, and it is what the caller's
      // exactly-one gate needs in order to refuse.
      const query = vi.fn().mockResolvedValue({ rows: [], fields: [], rowCount: null });
      await expect(
        new PostgresAdapter(stubPool({ query })).execute("UPDATE t SET a = 1"),
      ).resolves.toBe(0);
    });

    it("translates a rejected statement into a QueryError", async () => {
      const query = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("syntax error"), { code: "42601" }));
      await expect(
        new PostgresAdapter(stubPool({ query })).execute("UPDATE nope"),
      ).rejects.toBeInstanceOf(QueryError);
    });

    it("translates a dropped connection into a ConnectionError", async () => {
      const query = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("gone"), { code: "ECONNRESET" }));
      await expect(
        new PostgresAdapter(stubPool({ query })).execute("UPDATE t SET a = 1"),
      ).rejects.toBeInstanceOf(ConnectionError);
    });
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

  // Desktop ADR-0070. `pgOidToValue` decodes text-format bytes; handed
  // binary ones it does not throw, it produces garbage. The dangerous case
  // is quiet: a binary int4 of 1 is `00 00 00 01`, which is valid UTF-8 and
  // renders as four invisible control characters. Desktop shipped that in
  // v0.4.0. So the invariant is enforced at runtime rather than left to a
  // code comment about not passing `values`.
  describe("wire-format guard (desktop ADR-0070)", () => {
    it("rejects a binary-format column with a QueryError naming the format", async () => {
      const query = vi.fn().mockResolvedValue({
        fields: [{ name: "id", dataTypeID: 23, format: "binary" }],
        rows: [[Buffer.from([0, 0, 0, 1])]],
        rowCount: 1,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.executeQuery("SELECT id FROM users")).rejects.toBeInstanceOf(QueryError);
      await expect(adapter.executeQuery("SELECT id FROM users")).rejects.toThrow(/binary/i);
    });

    it("names the offending column so the report is actionable", async () => {
      const query = vi.fn().mockResolvedValue({
        fields: [
          { name: "id", dataTypeID: 23, format: "text" },
          { name: "payload", dataTypeID: 17, format: "binary" },
        ],
        rows: [["1", Buffer.from([1])]],
        rowCount: 1,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.executeQuery("SELECT id, payload FROM t")).rejects.toThrow(/payload/);
    });

    it("accepts an explicit text format", async () => {
      const query = vi.fn().mockResolvedValue({
        fields: [{ name: "id", dataTypeID: 23, format: "text" }],
        rows: [["1"]],
        rowCount: 1,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.executeQuery("SELECT id FROM users")).resolves.toMatchObject({
        rows: [[1]],
      });
    });

    // Absence is not evidence. pg's own result.js defaults the property
    // (`desc.format || 'text'`), and every hand-built stub in this suite
    // omits it. Rejecting on `format !== "text"` would fail ~30 specs while
    // asserting something the data does not say — see 0024 § invariant 1.
    it("accepts a field object that omits `format` entirely", async () => {
      const query = vi.fn().mockResolvedValue({
        fields: [{ name: "id", dataTypeID: 23 }],
        rows: [["1"]],
        rowCount: 1,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.executeQuery("SELECT id FROM users")).resolves.toMatchObject({
        rows: [[1]],
      });
    });
  });

  // An idle pooled client that errors emits on the Pool, not on any
  // caller's promise — there is no in-flight query to reject. pg's own
  // docs are explicit that an unhandled 'error' there takes the process
  // down, and the trigger is routine: a server restart, an admin
  // terminate, a pooler recycling the connection (Neon and Supabase both
  // do), or an idle TCP reset.
  //
  // Found by this ticket's integration tests: they shifted the teardown
  // timing enough that the container's shutdown FATAL (SQLSTATE 57P01)
  // landed on an idle client, and vitest reported an unhandled error. The
  // suite exposed it; the defect is in production code.
  describe("attachIdleClientErrorHandler", () => {
    it("registers an 'error' listener on the pool", () => {
      const on = vi.fn();
      attachIdleClientErrorHandler({ on });
      expect(on).toHaveBeenCalledWith("error", expect.any(Function));
    });

    it("swallows the error rather than rethrowing it", () => {
      let listener: ((e: Error) => void) | undefined;
      attachIdleClientErrorHandler({
        on: (_event, fn) => {
          listener = fn;
        },
      });
      expect(listener).toBeDefined();
      // Rethrowing here would be indistinguishable from not listening at
      // all: the emit happens on pg's socket callback, outside any
      // try/catch of ours.
      expect(() => listener?.(new Error("terminating connection"))).not.toThrow();
    });
  });

  describe("describeTable (desktop ADR-0028)", () => {
    // Every value arrives as a string: the pool's `getTypeParser` override
    // returns raw text for every OID, so `ordinal_position` is "1", not 1.
    const columnRow = (
      name: string,
      ordinal: string,
      overrides: Record<string, string | null> = {},
    ) => ({
      column_name: name,
      data_type: "integer",
      is_nullable: "NO",
      column_default: null,
      ordinal_position: ordinal,
      ...overrides,
    });

    function describingPool(columns: unknown[], pk: unknown[]) {
      const query = vi.fn().mockImplementation((cfg: { text: string }) =>
        Promise.resolve({
          rows: /table_constraints/.test(cfg.text) ? pk : columns,
          fields: [],
          rowCount: 0,
        }),
      );
      return { query, adapter: new PostgresAdapter(stubPool({ query })) };
    }

    it("binds schema and table rather than interpolating them", async () => {
      const { query, adapter } = describingPool([columnRow("id", "1")], []);
      await adapter.describeTable({ schema: "sales", name: "orders" });

      for (const call of query.mock.calls) {
        const cfg = call[0] as { text: string; values?: unknown[] };
        expect(cfg.values).toEqual(["sales", "orders"]);
        // The names must not reach the SQL text — that is the whole point
        // of binding them.
        expect(cfg.text).not.toMatch(/orders/);
      }
    });

    it("assembles columns in ordinal order with per-column primary-key flags", async () => {
      const { adapter } = describingPool(
        [
          columnRow("id", "1", {
            column_default: "nextval('orders_id_seq'::regclass)",
          }),
          columnRow("note", "2", {
            data_type: "text",
            is_nullable: "YES",
          }),
        ],
        [{ column_name: "id" }],
      );

      await expect(adapter.describeTable({ schema: "sales", name: "orders" })).resolves.toEqual({
        table: { schema: "sales", name: "orders" },
        columns: [
          {
            name: "id",
            declared_type: "integer",
            nullable: false,
            primary_key: true,
            ordinal: 1,
            default_value: "nextval('orders_id_seq'::regclass)",
          },
          {
            name: "note",
            declared_type: "text",
            nullable: true,
            primary_key: false,
            ordinal: 2,
            default_value: null,
          },
        ],
        primary_key: ["id"],
      });
    });

    it("keeps composite primary keys in key order, not column order", async () => {
      const { adapter } = describingPool(
        [columnRow("a", "1"), columnRow("b", "2")],
        [{ column_name: "b" }, { column_name: "a" }],
      );
      const out = await adapter.describeTable({ schema: "public", name: "pair" });
      expect(out.primary_key).toEqual(["b", "a"]);
      expect(out.columns.map((c) => c.primary_key)).toEqual([true, true]);
    });

    it("defaults an unqualified table to the public schema", async () => {
      const { query, adapter } = describingPool([columnRow("id", "1")], []);
      await adapter.describeTable({ schema: null, name: "orders" });
      expect((query.mock.calls[0]?.[0] as { values: unknown[] }).values).toEqual([
        "public",
        "orders",
      ]);
    });

    // information_schema answers an unknown table with an empty set, not an
    // error. Reporting a table with no columns would be indistinguishable
    // from a real one, so it becomes a 400 like the desktop's.
    it("rejects a table with no columns as a missing relation", async () => {
      const { adapter } = describingPool([], []);
      await expect(adapter.describeTable({ schema: "sales", name: "ghost" })).rejects.toThrow(
        /relation "sales\.ghost" does not exist/,
      );
      await expect(
        adapter.describeTable({ schema: "sales", name: "ghost" }),
      ).rejects.toBeInstanceOf(QueryError);
    });

    it("compares is_nullable case-insensitively", async () => {
      const { adapter } = describingPool([columnRow("id", "1", { is_nullable: "yes" })], []);
      const out = await adapter.describeTable({ schema: "public", name: "t" });
      expect(out.columns[0]?.nullable).toBe(true);
    });

    // ordinal_position is 1-based by the SQL standard. Anything else means
    // a catalog we do not understand; ordering the UI by a silent NaN would
    // be worse than failing.
    it("rejects a non-positive or unparseable ordinal", async () => {
      for (const bad of ["0", "-1", "", "many"]) {
        const { adapter } = describingPool([columnRow("id", bad)], []);
        await expect(adapter.describeTable({ schema: "public", name: "t" })).rejects.toThrow(
          /ordinal_position/,
        );
      }
    });

    // Binding parameters is what makes this path different from
    // executeQuery — the guard has to hold on the extended protocol too.
    it("still refuses a binary reply on the bound path (ADR-0070)", async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [],
        fields: [{ name: "column_name", dataTypeID: 25, format: "binary" }],
        rowCount: 0,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.describeTable({ schema: "public", name: "t" })).rejects.toThrow(
        /binary wire format/,
      );
    });

    it("routes a dropped socket to ConnectionError, like the other paths", async () => {
      const query = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.describeTable({ schema: "public", name: "t" })).rejects.toBeInstanceOf(
        ConnectionError,
      );
    });
  });

  describe("tableDdl (desktop ADR-0049)", () => {
    // Four catalog queries, dispatched on a fragment unique to each. The
    // defaults describe the smallest table that reconstructs: one column,
    // no constraints, no indexes, no sequences.
    function ddlPool(
      rows: Partial<Record<"columns" | "constraints" | "indexes" | "sequences", unknown[]>> = {},
      errors: Partial<Record<"sequences", unknown>> = {},
    ) {
      const columns = rows.columns ?? [
        { name: "id", type_name: "integer", not_null: "true", default_expr: null },
      ];
      const query = vi.fn().mockImplementation((cfg: { text: string }) => {
        if (/pg_sequence/.test(cfg.text)) {
          if (errors.sequences) return Promise.reject(errors.sequences);
          return Promise.resolve({ rows: rows.sequences ?? [], fields: [], rowCount: 0 });
        }
        if (/pg_get_indexdef/.test(cfg.text)) {
          return Promise.resolve({ rows: rows.indexes ?? [], fields: [], rowCount: 0 });
        }
        if (/pg_get_constraintdef/.test(cfg.text)) {
          return Promise.resolve({ rows: rows.constraints ?? [], fields: [], rowCount: 0 });
        }
        return Promise.resolve({ rows: columns, fields: [], rowCount: 0 });
      });
      return { query, adapter: new PostgresAdapter(stubPool({ query })) };
    }

    it("binds schema and table into every catalog query", async () => {
      const { query, adapter } = ddlPool();
      await adapter.tableDdl({ schema: "sales", name: "orders" });

      expect(query.mock.calls.length).toBe(4);
      for (const call of query.mock.calls) {
        const cfg = call[0] as { text: string; values?: unknown[] };
        expect(cfg.values).toEqual(["sales", "orders"]);
        expect(cfg.text).not.toMatch(/orders/);
      }
    });

    it("defaults an unqualified table to the public schema", async () => {
      const { query, adapter } = ddlPool();
      await adapter.tableDdl({ schema: null, name: "orders" });
      expect((query.mock.calls[0]?.[0] as { values: unknown[] }).values).toEqual([
        "public",
        "orders",
      ]);
    });

    it("assembles sequences, then the table, then standalone indexes", async () => {
      const { adapter } = ddlPool({
        columns: [
          { name: "id", type_name: "integer", not_null: "true", default_expr: "nextval('s')" },
          { name: "note", type_name: "text", not_null: "false", default_expr: null },
        ],
        constraints: [{ name: "orders_pkey", def: "PRIMARY KEY (id)" }],
        indexes: [{ def: "CREATE INDEX orders_note_idx ON sales.orders USING btree (note)" }],
        sequences: [
          {
            schema: "sales",
            name: "s",
            type_name: "bigint",
            start: "1",
            increment: "1",
            min_value: "1",
            max_value: "9223372036854775807",
            cache: "1",
            cycle: "false",
          },
        ],
      });

      expect(await adapter.tableDdl({ schema: "sales", name: "orders" })).toBe(
        'CREATE SEQUENCE "sales"."s" AS bigint START WITH 1 INCREMENT BY 1 ' +
          "MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;\n" +
          'CREATE TABLE "sales"."orders" (\n' +
          "    \"id\" integer NOT NULL DEFAULT nextval('s'),\n" +
          '    "note" text,\n' +
          '    CONSTRAINT "orders_pkey" PRIMARY KEY (id)\n' +
          ");\n" +
          "CREATE INDEX orders_note_idx ON sales.orders USING btree (note);\n",
      );
    });

    // `::TEXT` on the catalog booleans makes them "true"/"false" rather than
    // the raw wire "t"/"f" the type-parser override would otherwise hand
    // back. Both spellings decode, because the cast is easy to lose in a
    // later edit of the SQL and a silently-nullable column is a dump that
    // fails to load.
    it("decodes catalog booleans in either spelling", async () => {
      for (const yes of ["true", "t"]) {
        const { adapter } = ddlPool({
          columns: [{ name: "id", type_name: "integer", not_null: yes, default_expr: null }],
          sequences: [
            {
              schema: "public",
              name: "s",
              type_name: "bigint",
              start: "1",
              increment: "1",
              min_value: "1",
              max_value: "10",
              cache: "1",
              cycle: yes,
            },
          ],
        });
        const ddl = await adapter.tableDdl({ schema: "public", name: "t" });
        expect(ddl).toContain("NOT NULL");
        expect(ddl).toContain("CACHE 1 CYCLE;");
      }
    });

    // Aurora DSQL speaks pg-wire but models no `pg_sequence` (desktop
    // ADR-0021). The missing catalog is itself the signal, so the read
    // degrades to "no sequences" — on this SQLSTATE and no other.
    it("degrades to no sequences when pg_sequence does not exist", async () => {
      const { adapter } = ddlPool(
        {},
        { sequences: Object.assign(new Error("no rel"), { code: "42P01" }) },
      );
      const ddl = await adapter.tableDdl({ schema: "public", name: "t" });
      expect(ddl).not.toContain("CREATE SEQUENCE");
      expect(ddl).toContain('CREATE TABLE "public"."t"');
    });

    it("propagates any other failure of the sequence read", async () => {
      const { adapter } = ddlPool(
        {},
        { sequences: Object.assign(new Error("permission denied"), { code: "42501" }) },
      );
      await expect(adapter.tableDdl({ schema: "public", name: "t" })).rejects.toBeInstanceOf(
        QueryError,
      );
    });

    it("rejects a table with no columns as a missing relation", async () => {
      const { adapter } = ddlPool({ columns: [] });
      await expect(adapter.tableDdl({ schema: "sales", name: "ghost" })).rejects.toThrow(
        /relation "sales\.ghost" does not exist/,
      );
      await expect(adapter.tableDdl({ schema: "sales", name: "ghost" })).rejects.toBeInstanceOf(
        QueryError,
      );
    });

    it("still refuses a binary reply on the bound path (ADR-0070)", async () => {
      const query = vi.fn().mockResolvedValue({
        rows: [],
        fields: [{ name: "name", dataTypeID: 25, format: "binary" }],
        rowCount: 0,
      });
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.tableDdl({ schema: "public", name: "t" })).rejects.toThrow(
        /binary wire format/,
      );
    });

    it("routes a dropped socket to ConnectionError, like the other paths", async () => {
      const query = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      const adapter = new PostgresAdapter(stubPool({ query }));
      await expect(adapter.tableDdl({ schema: "public", name: "t" })).rejects.toBeInstanceOf(
        ConnectionError,
      );
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

describe("rebuildWith (0027 slice G)", () => {
  // `pg.Pool` opens nothing until the first query, so these build real pools
  // and never connect. Reading `pool.options` reaches through a `private`
  // field, deliberately: the guarantee under test is that the credential
  // reaches the successor's pool, and the production type offers no way to
  // ask for it. A getter would make the test tidier and the design worse.
  function poolOptionsOf(adapter: PostgresAdapter): Record<string, unknown> {
    return (adapter as unknown as { pool: { options: Record<string, unknown> } }).pool.options;
  }

  it("carries the credential of the connection it replaces", async () => {
    const before = createPostgresAdapter({
      host: "old.host",
      user: "reader",
      password: "OLD-PW",
      database: "app",
    });
    const after = before.rebuildWith({ host: "new.host", user: "reader", database: "app" });

    expect(poolOptionsOf(after)).toMatchObject({ host: "new.host", password: "OLD-PW" });
    await before.close();
    await after.close();
  });

  it("returns a successor, not a secret", async () => {
    // The credential leaves the old adapter only as far as the new one's
    // pool. There is no accessor that hands it back to a caller, which is
    // what keeps a rebuild from becoming a read.
    const before = createPostgresAdapter({ host: "old.host", password: "OLD-PW" });
    const after = before.rebuildWith({ host: "new.host" });

    expect(after).toBeInstanceOf(PostgresAdapter);
    expect(after).not.toBe(before);
    await before.close();
    await after.close();
  });

  it("takes the new password when the edit states one", async () => {
    const before = createPostgresAdapter({ host: "old.host", password: "OLD-PW" });
    const after = before.rebuildWith({ host: "old.host", password: "NEW-PW" });

    expect(poolOptionsOf(after)).toMatchObject({ password: "NEW-PW" });
    await before.close();
    await after.close();
  });

  it("replaces the configuration wholesale rather than merging it field by field", async () => {
    // The form submits every box it rendered, so a field that is absent was
    // cleared. Merging would make an emptied user box unsavable — the same
    // shape of bug as reading a blank password as a removal, pointing the
    // other way.
    const before = createPostgresAdapter({
      host: "old.host",
      user: "reader",
      database: "app",
      password: "OLD-PW",
    });
    const after = before.rebuildWith({ host: "old.host" });

    expect(poolOptionsOf(after).user).toBeUndefined();
    expect(poolOptionsOf(after).database).toBeUndefined();
    // The password is the one exception, and it is an exception on purpose.
    expect(poolOptionsOf(after).password).toBe("OLD-PW");
    await before.close();
    await after.close();
  });
});
