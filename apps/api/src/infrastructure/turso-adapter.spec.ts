import { createClient, type Client } from "@libsql/client";
import { afterEach, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, QueryError } from "../domain/errors";
import { decodeBlob, isBlobValue, type BlobValue } from "../domain/values";
import { createTursoAdapter, TursoAdapter } from "./turso-adapter";

// Mirrors desktop `crates/dbboard-turso/tests/in_memory.rs`: the adapter is
// exercised against a real libSQL engine opened at `:memory:`, not a stub.
// A stub would prove the adapter calls the driver; only the engine proves
// the SQL is right — the PRAGMA escaping and the composite-key ordering
// below are both things a stub would happily agree with while being wrong.
//
// The constructor takes an already-open client for exactly this reason.
// `createTursoAdapter` — the path an HTTP request reaches — refuses local
// URLs, so the tests cannot go through it.

const open = (): Client => createClient({ url: ":memory:", intMode: "bigint" });

let openClients: Client[] = [];

function adapterOn(client: Client): TursoAdapter {
  openClients.push(client);
  return new TursoAdapter(client);
}

afterEach(() => {
  for (const client of openClients) client.close();
  openClients = [];
});

async function seeded(...ddl: string[]): Promise<TursoAdapter> {
  const adapter = adapterOn(open());
  for (const statement of ddl) await adapter.execute(statement);
  return adapter;
}

describe("TursoAdapter identity", () => {
  it("reports the driver id the factory registers", () => {
    expect(adapterOn(open()).getId()).toBe("turso");
  });

  it("reports the flags its shipped desktop counterpart reports", async () => {
    const adapter = adapterOn(open());
    const caps = adapter.getCapabilities();

    expect(caps.has_describe_table).toBe(true);
    expect(caps.has_execute).toBe(true);
    expect(caps.has_atomic_restore).toBe(true);
    // Desktop's `dbboard-turso` has no `table_ddl` — the string does not
    // appear in the crate, so its `..Capabilities::default()` tail leaves
    // the flag false. This is the first flag on web that varies by adapter
    // rather than by rung, and the dump use case reads it to decide
    // between a dump and a CapabilityError.
    expect(caps.has_table_ddl).toBe(false);
  });

  it("omits the hook it reports false, rather than shipping a stub", () => {
    // The port's contract: "an adapter that implements this also sets
    // `has_table_ddl`; the two travel together". A method that throws
    // would satisfy the flag and break the rule.
    // Read through the port, because that is where the optional hook is
    // declared — `TursoAdapter` not having the property is what makes this
    // compile-checkable at all.
    const adapter: DatabaseAdapter = adapterOn(open());
    expect(adapter.tableDdl).toBeUndefined();
  });
});

describe("TursoAdapter.listTables", () => {
  it("lists user tables by name with no schema namespace", async () => {
    const adapter = await seeded(
      "CREATE TABLE zebra (id INTEGER)",
      "CREATE TABLE alpha (id INTEGER)",
    );

    await expect(adapter.listTables()).resolves.toEqual([
      { schema: null, name: "alpha" },
      { schema: null, name: "zebra" },
    ]);
  });

  it("hides SQLite's own bookkeeping tables", async () => {
    // An AUTOINCREMENT column makes SQLite create `sqlite_sequence`, which
    // is the reachable case for the `sqlite_%` filter desktop applies.
    const adapter = await seeded(
      "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT)",
      "INSERT INTO t DEFAULT VALUES",
    );

    const names = (await adapter.listTables()).map((t) => t.name);
    expect(names).toEqual(["t"]);
  });
});

describe("TursoAdapter.executeQuery", () => {
  it("returns columns with their declared types and rows in order", async () => {
    const adapter = await seeded(
      "CREATE TABLE t (id INTEGER, label TEXT)",
      "INSERT INTO t VALUES (1, 'one'), (2, 'two')",
    );

    const result = await adapter.executeQuery("SELECT id, label FROM t ORDER BY id");

    expect(result.columns).toEqual([
      { name: "id", declared_type: "INTEGER" },
      { name: "label", declared_type: "TEXT" },
    ]);
    expect(result.rows).toEqual([
      [1, "one"],
      [2, "two"],
    ]);
  });

  it("reports no declared type for an expression column", async () => {
    const result = await adapterOn(open()).executeQuery("SELECT 1 + 1 AS sum");

    expect(result.columns).toEqual([{ name: "sum", declared_type: null }]);
    expect(result.rows).toEqual([[2]]);
  });

  it("carries a 64-bit integer out as text when it will not fit a JSON number", async () => {
    // Reachable with an ordinary rowid, not a contrived value: SQLite's
    // INTEGER is 64-bit. Proves `intMode: "bigint"` is actually set on the
    // client — with the default the driver would have truncated before the
    // mapping ever saw it.
    const result = await adapterOn(open()).executeQuery("SELECT 9007199254740993 AS big");

    expect(result.rows).toEqual([["9007199254740993"]]);
  });

  it("carries a non-finite real out as text rather than losing it to JSON", async () => {
    const result = await adapterOn(open()).executeQuery("SELECT 9e999 AS huge");

    expect(result.rows).toEqual([["Infinity"]]);
  });

  it("tags a blob so it survives JSON", async () => {
    const result = await adapterOn(open()).executeQuery("SELECT x'0001ff' AS b");

    const cell = result.rows[0]?.[0];
    expect(isBlobValue(cell)).toBe(true);
    expect(Array.from(decodeBlob(cell as BlobValue))).toEqual([0, 1, 255]);
  });

  it("reports a NULL cell as null", async () => {
    const result = await adapterOn(open()).executeQuery("SELECT NULL AS n");

    expect(result.rows).toEqual([[null]]);
  });

  it("routes a DML statement without the caller having to say so", async () => {
    // Desktop routes by first keyword because libSQL's Rust driver rejects
    // a SELECT sent through `execute`. The JS client has one entry point
    // for both, so the router is not mirrored — this pins that the
    // simplification actually holds rather than being assumed.
    const adapter = await seeded("CREATE TABLE t (id INTEGER)");

    const result = await adapter.executeQuery("INSERT INTO t VALUES (1), (2)");

    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
    expect(result.rows_affected).toBe(2);
  });

  it("raises a query error the caller can be blamed for", async () => {
    await expect(adapterOn(open()).executeQuery("SELECT * FROM nope")).rejects.toBeInstanceOf(
      QueryError,
    );
  });
});

describe("TursoAdapter.describeTable", () => {
  it("numbers columns from one and reports nullability, keys and defaults", async () => {
    // SQLite's `PRAGMA table_info.cid` counts from zero; the contract's
    // `ordinal` counts from one, so the adapter normalises it.
    const adapter = await seeded(
      "CREATE TABLE t (id INTEGER PRIMARY KEY, label TEXT NOT NULL DEFAULT 'x', note TEXT)",
    );

    const schema = await adapter.describeTable({ schema: null, name: "t" });

    expect(schema.table).toEqual({ schema: null, name: "t" });
    expect(schema.columns).toEqual([
      {
        name: "id",
        declared_type: "INTEGER",
        nullable: true,
        primary_key: true,
        ordinal: 1,
        default_value: null,
      },
      {
        name: "label",
        declared_type: "TEXT",
        nullable: false,
        primary_key: false,
        ordinal: 2,
        default_value: "'x'",
      },
      {
        name: "note",
        declared_type: "TEXT",
        nullable: true,
        primary_key: false,
        ordinal: 3,
        default_value: null,
      },
    ]);
    expect(schema.primary_key).toEqual(["id"]);
  });

  it("reports a composite key in key order, not in column order", async () => {
    // `PRAGMA table_info.pk` is the 1-based position within the key, and it
    // does not follow column order. Deriving the key by filtering `columns`
    // would silently produce ["a", "b"] here.
    const adapter = await seeded("CREATE TABLE t (a INTEGER, b TEXT, PRIMARY KEY (b, a))");

    const schema = await adapter.describeTable({ schema: null, name: "t" });

    expect(schema.primary_key).toEqual(["b", "a"]);
  });

  it("reports a typeless column as having no declared type", async () => {
    const adapter = await seeded("CREATE TABLE t (anything)");

    const schema = await adapter.describeTable({ schema: null, name: "t" });

    expect(schema.columns[0]?.declared_type).toBeNull();
  });

  it("survives a quote in the table name", async () => {
    // A PRAGMA argument cannot be bound, so the name is interpolated with
    // single quotes doubled. Without the doubling this statement does not
    // parse — and a hostile schema, not just an awkward one, is what makes
    // that worth a test.
    const adapter = await seeded(`CREATE TABLE "it's" (id INTEGER)`);

    const schema = await adapter.describeTable({ schema: null, name: "it's" });

    expect(schema.columns.map((c) => c.name)).toEqual(["id"]);
  });

  it("raises a query error for a table that is not there", async () => {
    // PRAGMA returns zero rows rather than failing, so the adapter has to
    // synthesise SQLite's own message shape (desktop ADR-0028: a missing
    // table is a query error, not a 500).
    const adapter = adapterOn(open());

    await expect(adapter.describeTable({ schema: null, name: "nope" })).rejects.toThrow(
      /no such table: nope/,
    );
    await expect(adapter.describeTable({ schema: null, name: "nope" })).rejects.toBeInstanceOf(
      QueryError,
    );
  });
});

describe("TursoAdapter.execute", () => {
  it("reports the rows a write touched", async () => {
    const adapter = await seeded(
      "CREATE TABLE t (id INTEGER)",
      "INSERT INTO t VALUES (1), (2), (3)",
    );

    await expect(adapter.execute("DELETE FROM t WHERE id > 1")).resolves.toBe(2);
  });

  it("reports zero for DDL", async () => {
    await expect(adapterOn(open()).execute("CREATE TABLE t (id INTEGER)")).resolves.toBe(0);
  });

  it("raises a query error rather than returning a count", async () => {
    await expect(adapterOn(open()).execute("DELETE FROM nope")).rejects.toBeInstanceOf(QueryError);
  });
});

describe("TursoAdapter.executeInTransaction", () => {
  it("commits every statement or none of them", async () => {
    const adapter = await seeded("CREATE TABLE t (id INTEGER PRIMARY KEY)");

    await expect(
      adapter.executeInTransaction(["INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (1)"]),
    ).rejects.toBeInstanceOf(QueryError);

    // The first insert would have succeeded on its own. This is the whole
    // promise `has_atomic_restore: true` makes to the restore runner.
    const after = await adapter.executeQuery("SELECT COUNT(*) AS n FROM t");
    expect(after.rows).toEqual([[0]]);
  });

  it("commits a batch that succeeds", async () => {
    const adapter = await seeded("CREATE TABLE t (id INTEGER)");

    await adapter.executeInTransaction(["INSERT INTO t VALUES (1)", "INSERT INTO t VALUES (2)"]);

    const after = await adapter.executeQuery("SELECT COUNT(*) AS n FROM t");
    expect(after.rows).toEqual([[2]]);
  });

  it("treats an empty batch as a no-op", async () => {
    // Opening and committing an empty transaction is a pointless round
    // trip, and desktop returns early rather than leaving a dangling BEGIN.
    await expect(adapterOn(open()).executeInTransaction([])).resolves.toBeUndefined();
  });
});

describe("createTursoAdapter", () => {
  it("builds an adapter for a remote libSQL URL", () => {
    const adapter = createTursoAdapter({
      connectionString: "libsql://db-org.turso.io",
      authToken: "token",
    });

    expect(adapter).toBeInstanceOf(TursoAdapter);
    expect(adapter.getId()).toBe("turso");
    void adapter.close();
  });

  it("refuses a local file URL", () => {
    // Web is a server. `AdapterConfig` arrives in an HTTP request body, so
    // a `file:` URL would let any caller open any file the API process can
    // read — desktop has no equivalent exposure because the same string
    // comes from the machine's own operator.
    expect(() => createTursoAdapter({ connectionString: "file:/etc/passwd" })).toThrow(
      CapabilityError,
    );
  });

  it("refuses an in-memory URL", () => {
    // Not a security hole on its own, but it silently produces a database
    // that is empty, unshared and gone at process exit — a connection that
    // looks healthy and is useless.
    expect(() => createTursoAdapter({ connectionString: ":memory:" })).toThrow(CapabilityError);
  });

  it("refuses a URL with no scheme it recognises", () => {
    expect(() => createTursoAdapter({ connectionString: "/var/data/app.db" })).toThrow(
      CapabilityError,
    );
  });

  it("refuses a config with no URL at all", () => {
    expect(() => createTursoAdapter({})).toThrow(CapabilityError);
  });

  it("accepts the HTTP and WebSocket schemes the driver also speaks", () => {
    for (const url of [
      "https://db-org.turso.io",
      "wss://db-org.turso.io",
      "http://localhost:8080",
      "ws://localhost:8080",
    ]) {
      const adapter = createTursoAdapter({ connectionString: url });
      expect(adapter).toBeInstanceOf(TursoAdapter);
      void adapter.close();
    }
  });
});
