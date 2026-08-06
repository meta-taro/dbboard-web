import { describe, expect, it } from "vitest";
import {
  CapabilityError,
  ConnectionError,
  QueryError,
  SchemaError,
  TypeConversionError,
} from "../domain/errors";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { decodeBlob, isBlobValue, type BlobValue } from "../domain/values";
import { createD1Adapter, D1Adapter, type D1Response, type D1Transport } from "./d1-adapter";

// Desktop's D1 crate is tested two ways: an inline `mod tests` over hand-
// built envelopes, and `tests/rest_roundtrip.rs` against a live database
// behind env gates. This file is the first half — D1 has no local engine to
// open, so unlike `turso-adapter.spec.ts` there is no `:memory:` to fall
// back on, and the envelope is the only thing available to pin. The second
// half lives in `test/d1-integration.spec.ts`, gated the same way desktop
// gates its round trip.
//
// The transport is the seam. It hands back a status and the response text
// exactly as an HTTP client would, so everything the adapter decides —
// parsing, envelope shape, error classification — is under test, and only
// the socket is not.

type Exchange = { sql: string; response: D1Response };

class StubTransport implements D1Transport {
  readonly sent: string[] = [];

  constructor(private readonly queue: Exchange[]) {}

  post(sql: string): Promise<D1Response> {
    this.sent.push(sql);
    const next = this.queue.shift();
    if (!next) throw new Error(`stub transport: unexpected statement ${sql}`);
    return Promise.resolve(next.response);
  }
}

function ok(result: unknown): D1Response {
  return { status: 200, body: JSON.stringify({ success: true, result, errors: [] }) };
}

/** One statement result in the shape `/raw` returns. */
function statement(columns: string[], rows: unknown[][], changes = 0): unknown {
  return { results: { columns, rows }, meta: { changes } };
}

function failing(status: number, errors: unknown[]): D1Response {
  return { status, body: JSON.stringify({ success: false, result: [], errors }) };
}

function adapterFor(...responses: D1Response[]): { adapter: D1Adapter; transport: StubTransport } {
  const transport = new StubTransport(responses.map((response) => ({ sql: "", response })));
  return { adapter: new D1Adapter(transport), transport };
}

describe("D1Adapter identity", () => {
  it("reports the driver id the factory registers", () => {
    expect(adapterFor().adapter.getId()).toBe("d1");
  });

  it("reports every capability desktop's crate reports, and no more", () => {
    // Desktop `crates/dbboard-d1` at b98f7a6: describe_table, table_ddl,
    // execute — and `has_atomic_restore` left false by the `..default()`
    // tail, because `/raw` has no multi-statement transaction. Desktop's
    // tenth flag, `has_foreign_keys` (ADR-0054), has no web counterpart:
    // `Capabilities` has nine and no web surface consumes edges yet.
    expect(adapterFor().adapter.getCapabilities()).toEqual({
      has_views: false,
      has_functions: false,
      has_auth: false,
      has_storage: false,
      has_realtime: false,
      has_describe_table: true,
      has_table_ddl: true,
      has_execute: true,
      has_atomic_restore: false,
    });
  });

  it("omits executeInTransaction, so the flag and the hook agree", () => {
    // The port's rule — a flag is true only where the hook exists — read
    // backwards. RestoreDatabase dispatches on the hook, so an adapter that
    // grew one while reporting `has_atomic_restore: false` would run the
    // atomic branch and report the opposite to the client.
    // Read through the port, not the class: on `D1Adapter` the member does
    // not exist at all, so the class-typed expression is a compile error
    // rather than the runtime check this test is making.
    const port: DatabaseAdapter = adapterFor().adapter;
    expect(port.executeInTransaction).toBeUndefined();
  });
});

describe("D1Adapter.executeQuery", () => {
  it("reads columns, rows and the affected count out of one envelope", async () => {
    const { adapter } = adapterFor(ok([statement(["id", "name"], [[1, "ada"]], 0)]));
    await expect(adapter.executeQuery("SELECT id, name FROM t")).resolves.toEqual({
      columns: [
        { name: "id", declared_type: null },
        { name: "name", declared_type: null },
      ],
      rows: [[1, "ada"]],
      rows_affected: 0,
    });
  });

  it("reports no declared type for any column", async () => {
    // `/raw` does not carry per-column types. Desktop sets `declared_type:
    // None` unconditionally for the same reason; guessing from the first
    // row's storage class would label an all-NULL column wrongly.
    const { adapter } = adapterFor(ok([statement(["n"], [[null]])]));
    const result = await adapter.executeQuery("SELECT n FROM t");
    expect(result.columns).toEqual([{ name: "n", declared_type: null }]);
  });

  it("takes the affected count from meta.changes", async () => {
    // The same envelope comes back for DML, which is why the adapter needs
    // no statement router — the thing desktop's Rust driver forced on Turso.
    const { adapter } = adapterFor(ok([statement([], [], 3)]));
    const result = await adapter.executeQuery("DELETE FROM t");
    expect(result).toEqual({ columns: [], rows: [], rows_affected: 3 });
  });

  it("maps each cell through the JSON storage-class mapping", async () => {
    const { adapter } = adapterFor(
      ok([statement(["a", "b", "c", "d"], [[null, true, 1.5, [1, 2]]])]),
    );
    const [row] = (await adapter.executeQuery("SELECT * FROM t")).rows;
    expect(row[0]).toBeNull();
    expect(row[1]).toBe(1);
    expect(row[2]).toBe(1.5);
    expect(isBlobValue(row[3])).toBe(true);
    expect(Array.from(decodeBlob(row[3] as BlobValue))).toEqual([1, 2]);
  });

  it("reports an uninterpretable cell as a type conversion, not a 500", async () => {
    const { adapter } = adapterFor(ok([statement(["a"], [[{ nested: true }]])]));
    await expect(adapter.executeQuery("SELECT a FROM t")).rejects.toThrow(TypeConversionError);
  });

  it("does not cap the row count", async () => {
    // ROW_CAP belongs to ExecuteQuery, which applies it after the adapter
    // returns (`domain/limits.ts`: "so no adapter can forget"). Desktop
    // checks `MAX_RESULT_ROWS` inside the adapter because its cap lives in
    // core; mirroring that here would cap twice and report the wrong error
    // shape for the second one.
    const rows = Array.from({ length: 10_001 }, (_, i) => [i]);
    const { adapter } = adapterFor(ok([statement(["i"], rows)]));
    await expect(adapter.executeQuery("SELECT i FROM t")).resolves.toMatchObject({
      rows_affected: 0,
    });
  });

  it("reports an envelope with no statement result as a query error", async () => {
    const { adapter } = adapterFor(ok([]));
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(QueryError);
  });
});

describe("D1Adapter error classification", () => {
  it("reads 401 and 403 as a connection failure", async () => {
    // Not the caller's SQL. A 400 would send the user back to their query
    // to find a mistake that is not in it.
    for (const status of [401, 403]) {
      const { adapter } = adapterFor(failing(status, [{ code: 10000, message: "bad token" }]));
      await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(ConnectionError);
    }
  });

  it("reads 429 and 5xx as a connection failure", async () => {
    for (const status of [429, 500, 503]) {
      const { adapter } = adapterFor(failing(status, [{ message: "slow down" }]));
      await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(ConnectionError);
    }
  });

  it("reads anything else as the caller's query error", async () => {
    const { adapter } = adapterFor(
      failing(400, [{ code: 7500, message: "no such table: absent" }]),
    );
    await expect(adapter.executeQuery("SELECT 1 FROM absent")).rejects.toThrow(
      /no such table: absent/,
    );
  });

  it("prefixes an error code when Cloudflare sends one", async () => {
    const { adapter } = adapterFor(failing(400, [{ code: 7500, message: "not authorized" }]));
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/\[7500\] not authorized/);
  });

  it("joins several errors rather than reporting only the first", async () => {
    const { adapter } = adapterFor(
      failing(400, [{ message: "first" }, { code: 2, message: "second" }]),
    );
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/first; \[2\] second/);
  });

  it("says something when the failure carries no message at all", async () => {
    const { adapter } = adapterFor(failing(400, []));
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/without an error message/);
  });

  it("truncates a hostile error body", async () => {
    // Desktop caps at 2048 bytes so a malformed response cannot dump an
    // unbounded string into the UI. Here the string would reach an HTTP
    // error body instead, which is no better.
    const { adapter } = adapterFor(failing(400, [{ message: "x".repeat(9000) }]));
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/…$/);
    await adapter.executeQuery("SELECT 1").catch((e: Error) => {
      expect(e.message.length).toBeLessThanOrEqual(2049);
    });
  });

  it("reports a non-JSON body as a connection failure", async () => {
    // A divergence from desktop, which calls this `Query`. A Cloudflare
    // HTML 5xx page is the likeliest way to get here, and the house rule
    // (`turso-adapter.ts`, `isConnectionLevelError`) is that a 502 which
    // turns out to be a bad query misleads far less than a 400 which turns
    // out to be a dead server.
    const { adapter } = adapterFor({ status: 502, body: "<html>bad gateway</html>" });
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(ConnectionError);
  });

  it("keeps the malformed body short in the message", async () => {
    const { adapter } = adapterFor({ status: 500, body: "<html>".repeat(2000) });
    await adapter.executeQuery("SELECT 1").catch((e: Error) => {
      expect(e.message.length).toBeLessThanOrEqual(2100);
    });
  });

  it("reports a transport failure as a connection failure", async () => {
    const transport: D1Transport = {
      post: () => Promise.reject(new Error("fetch failed")),
    };
    await expect(new D1Adapter(transport).executeQuery("SELECT 1")).rejects.toThrow(
      ConnectionError,
    );
  });

  it("scrubs the API token out of a transport message", async () => {
    // A client that echoes the request — headers included — would otherwise
    // put a bearer credential into an HTTP error body.
    const transport: D1Transport = {
      post: () => Promise.reject(new Error("failed with Authorization: Bearer s3cr3t")),
    };
    const adapter = new D1Adapter(transport, "s3cr3t");
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/\*\*\*/);
    await expect(adapter.executeQuery("SELECT 1")).rejects.not.toThrow(/s3cr3t/);
  });
});

describe("D1Adapter.listTables", () => {
  it("excludes SQLite's own tables and Cloudflare's", async () => {
    // `_cf_KV` exists in every D1 database, `sqlite_master` lists it, and
    // the Workers authorizer refuses to open it — `[7500] not authorized`.
    // Desktop found this by watching it blank the whole structure view,
    // because the relationship sweep PRAGMAs every listed table.
    //
    // `ESCAPE '\'` makes the underscores literal: unescaped, LIKE's `_`
    // wildcard would also drop a user table named `acf_log`.
    const { adapter, transport } = adapterFor(ok([statement(["name"], [["users"]])]));
    await adapter.listTables();
    expect(transport.sent[0]).toContain("NOT LIKE 'sqlite_%'");
    expect(transport.sent[0]).toContain("NOT LIKE '\\_cf\\_%' ESCAPE '\\'");
    expect(transport.sent[0]).toContain("ORDER BY name");
  });

  it("returns unqualified names in the order the engine gave them", async () => {
    const { adapter } = adapterFor(ok([statement(["name"], [["a"], ["b"]])]));
    await expect(adapter.listTables()).resolves.toEqual([
      { schema: null, name: "a" },
      { schema: null, name: "b" },
    ]);
  });

  it("reports a non-text name cell as a schema error", async () => {
    // The envelope is not what `sqlite_master` produces, so the fault is
    // upstream of the caller's request — 502, not 400.
    const { adapter } = adapterFor(ok([statement(["name"], [[42]])]));
    await expect(adapter.listTables()).rejects.toThrow(SchemaError);
  });

  it("re-tags a failed introspection query as a schema error", async () => {
    // Desktop's `reclassify_schema`. The caller did not write this SQL, so
    // reporting it as their query error points them at the wrong thing.
    const { adapter } = adapterFor(failing(400, [{ message: "malformed" }]));
    await expect(adapter.listTables()).rejects.toThrow(SchemaError);
  });

  it("leaves a connection failure a connection failure", async () => {
    const { adapter } = adapterFor(failing(503, [{ message: "down" }]));
    await expect(adapter.listTables()).rejects.toThrow(ConnectionError);
  });
});

describe("D1Adapter.describeTable", () => {
  const pragmaColumns = ["cid", "name", "type", "notnull", "dflt_value", "pk"];

  it("maps a PRAGMA row onto the contract's column shape", async () => {
    const { adapter } = adapterFor(
      ok([statement(pragmaColumns, [[0, "id", "INTEGER", 1, null, 1]])]),
    );
    await expect(adapter.describeTable({ schema: null, name: "t" })).resolves.toEqual({
      table: { schema: null, name: "t" },
      columns: [
        {
          name: "id",
          declared_type: "INTEGER",
          nullable: false,
          primary_key: true,
          // `cid` counts from zero; the contract's ordinal counts from one.
          ordinal: 1,
          default_value: null,
        },
      ],
      primary_key: ["id"],
    });
  });

  it("orders a composite key by key position, not column position", async () => {
    // PRAGMA emits rows in column order and carries the key position in
    // `pk`; a two-column key declared in the reverse order is the case that
    // separates the two.
    const { adapter } = adapterFor(
      ok([
        statement(pragmaColumns, [
          [0, "a", "TEXT", 0, null, 2],
          [1, "b", "TEXT", 0, null, 1],
        ]),
      ]),
    );
    const schema = await adapter.describeTable({ schema: null, name: "t" });
    expect(schema.primary_key).toEqual(["b", "a"]);
  });

  it("reads an empty declared type as none", async () => {
    const { adapter } = adapterFor(ok([statement(pragmaColumns, [[0, "x", "", 0, null, 0]])]));
    const schema = await adapter.describeTable({ schema: null, name: "t" });
    expect(schema.columns[0].declared_type).toBeNull();
  });

  it("keeps a default expression as its text", async () => {
    const { adapter } = adapterFor(
      ok([statement(pragmaColumns, [[0, "x", "TEXT", 0, "'hi'", 0]])]),
    );
    const schema = await adapter.describeTable({ schema: null, name: "t" });
    expect(schema.columns[0].default_value).toBe("'hi'");
  });

  it("locates PRAGMA columns by name, not by position", async () => {
    // Desktop does the same, so a reordered envelope still maps correctly
    // rather than silently swapping `notnull` for `pk`.
    const { adapter } = adapterFor(
      ok([
        statement(
          ["pk", "name", "cid", "dflt_value", "type", "notnull"],
          [[1, "id", 0, null, "INTEGER", 1]],
        ),
      ]),
    );
    const schema = await adapter.describeTable({ schema: null, name: "t" });
    expect(schema.columns[0]).toMatchObject({ name: "id", primary_key: true, ordinal: 1 });
  });

  it("reports a PRAGMA envelope missing a column as a schema error", async () => {
    const { adapter } = adapterFor(ok([statement(["cid", "name"], [[0, "id"]])]));
    await expect(adapter.describeTable({ schema: null, name: "t" })).rejects.toThrow(SchemaError);
  });

  it("doubles a single quote in the table name", async () => {
    // A PRAGMA argument cannot be bound, and the name arrives in a request
    // body — nothing upstream guarantees it came from `listTables`.
    const { adapter, transport } = adapterFor(
      ok([statement(pragmaColumns, [[0, "x", "TEXT", 0, null, 0]])]),
    );
    await adapter.describeTable({ schema: null, name: "it's" });
    expect(transport.sent[0]).toBe("PRAGMA table_info('it''s')");
  });

  it("reports a missing table as a query error carrying SQLite's own words", async () => {
    // PRAGMA returns zero rows rather than failing, so the message is
    // synthesised. Desktop ADR-0028: a missing table is the caller's
    // mistake, not a 500.
    const { adapter } = adapterFor(ok([statement(pragmaColumns, [])]));
    await expect(adapter.describeTable({ schema: null, name: "absent" })).rejects.toThrow(
      /no such table: absent/,
    );
    const { adapter: again } = adapterFor(ok([statement(pragmaColumns, [])]));
    await expect(again.describeTable({ schema: null, name: "absent" })).rejects.toThrow(QueryError);
  });
});

describe("D1Adapter.tableDdl", () => {
  it("returns the table's CREATE first, then each index, all terminated", async () => {
    const { adapter } = adapterFor(
      ok([
        statement(
          ["type", "sql"],
          [
            ["table", "CREATE TABLE t (id INTEGER)"],
            ["index", "CREATE INDEX i ON t (id)"],
          ],
        ),
      ]),
    );
    await expect(adapter.tableDdl({ schema: null, name: "t" })).resolves.toBe(
      "CREATE TABLE t (id INTEGER);\nCREATE INDEX i ON t (id);\n",
    );
  });

  it("asks sqlite_master to sort the table row ahead of the indexes", async () => {
    const { adapter, transport } = adapterFor(
      ok([statement(["type", "sql"], [["table", "CREATE TABLE t (id INTEGER)"]])]),
    );
    await adapter.tableDdl({ schema: null, name: "t" });
    expect(transport.sent[0]).toContain("ORDER BY (type = 'table') DESC, name");
    // Auto-created indexes (those backing PRIMARY KEY / UNIQUE) carry a
    // NULL `sql` and would emit "CREATE null;" — the table DDL recreates
    // them implicitly, so they are filtered in SQL rather than here.
    expect(transport.sent[0]).toContain("sql IS NOT NULL");
  });

  it("doubles a single quote in the table name", async () => {
    const { adapter, transport } = adapterFor(
      ok([statement(["type", "sql"], [["table", "CREATE TABLE x (a)"]])]),
    );
    await adapter.tableDdl({ schema: null, name: "it's" });
    expect(transport.sent[0]).not.toContain("'it's'");
    expect(transport.sent[0]).toContain("'it''s'");
  });

  it("reports a missing table as a query error, matching describeTable", async () => {
    const { adapter } = adapterFor(ok([statement(["type", "sql"], [])]));
    await expect(adapter.tableDdl({ schema: null, name: "absent" })).rejects.toThrow(
      /no such table: absent/,
    );
  });

  it("treats orphan index rows as a missing table too", async () => {
    // Not reachable from SQLite, which drops a table's indexes with it.
    // Emitting the indexes alone would produce a dump that cannot restore.
    const { adapter } = adapterFor(
      ok([statement(["type", "sql"], [["index", "CREATE INDEX i ON absent (id)"]])]),
    );
    await expect(adapter.tableDdl({ schema: null, name: "absent" })).rejects.toThrow(QueryError);
  });

  it("reports a non-text sqlite_master cell as a schema error", async () => {
    const { adapter } = adapterFor(ok([statement(["type", "sql"], [[1, 2]])]));
    await expect(adapter.tableDdl({ schema: null, name: "t" })).rejects.toThrow(SchemaError);
  });
});

describe("D1Adapter.execute", () => {
  it("returns the affected count and discards the rows", async () => {
    const { adapter } = adapterFor(ok([statement([], [], 2)]));
    await expect(adapter.execute("UPDATE t SET a = 1")).resolves.toBe(2);
  });

  it("reports zero for DDL", async () => {
    const { adapter } = adapterFor(ok([statement([], [], 0)]));
    await expect(adapter.execute("CREATE TABLE t (a)")).resolves.toBe(0);
  });
});

describe("createD1Adapter", () => {
  const complete = { accountId: "acct", databaseId: "db", authToken: "tok" };

  it("refuses a missing account id", () => {
    expect(() => createD1Adapter({ ...complete, accountId: undefined })).toThrow(CapabilityError);
  });

  it("refuses a missing database id", () => {
    expect(() => createD1Adapter({ ...complete, databaseId: undefined })).toThrow(CapabilityError);
  });

  it("refuses a blank API token rather than sending an empty bearer header", () => {
    // Desktop fails fast here for the same reason: an exported-but-empty
    // token otherwise buys a 401 that reads like a wrong credential rather
    // than a missing one.
    expect(() => createD1Adapter({ ...complete, authToken: "   " })).toThrow(CapabilityError);
  });

  it("builds an adapter when all three are present", () => {
    expect(createD1Adapter(complete).getId()).toBe("d1");
  });

  it("refuses an id that would escape the D1 path", () => {
    // Web-only, and a boundary rather than tidiness: desktop takes these
    // from the operator of the machine it runs on, web takes them from an
    // HTTP request body. A `../..` would otherwise aim an authenticated
    // request at another Cloudflare API — the account's own zones, say.
    expect(() => createD1Adapter({ ...complete, accountId: "../../zones" })).toThrow(
      CapabilityError,
    );
    expect(() => createD1Adapter({ ...complete, databaseId: "a/b" })).toThrow(CapabilityError);
  });

  it("ignores a caller-supplied connection string", () => {
    // Desktop's `D1Config` has a `base_url` for tests and self-hosted
    // gateways. Web does not expose one: the endpoint is fixed, so a
    // request body cannot point an authenticated adapter at an address
    // inside the deployment's network.
    const adapter = createD1Adapter({ ...complete, connectionString: "http://169.254.169.254/" });
    expect(adapter.getId()).toBe("d1");
  });
});

describe("D1Adapter.rebuildWith", () => {
  const complete = { accountId: "acct", databaseId: "db", authToken: "tok" };

  it("keeps the current token when an edit does not supply one", () => {
    // ADR-0080, the same reading `carryCredential` gives a password: an
    // edit form never prefills a credential box, so `""` round-trips for
    // the one nobody typed in. Taking it literally would swap a working
    // token for an empty bearer header and blame the user for the 401.
    const rebuilt = createD1Adapter(complete).rebuildWith({
      accountId: "acct",
      databaseId: "other",
      authToken: "",
    });
    expect(rebuilt.getId()).toBe("d1");
  });

  it("refuses an edit that drops a required field, leaving the original intact", () => {
    const original = createD1Adapter(complete);
    expect(() => original.rebuildWith({ databaseId: "other", authToken: "tok" })).toThrow(
      CapabilityError,
    );
    expect(original.getId()).toBe("d1");
  });
});
