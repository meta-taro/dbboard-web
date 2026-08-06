import { describe, expect, it } from "vitest";

import {
  CapabilityError,
  ConnectionError,
  QueryError,
  SchemaError,
  TypeConversionError,
} from "../domain/errors";
import { decodeBlob, isBlobValue } from "../domain/values/value";
import {
  carryMySqlCredential,
  createMySqlAdapter,
  MySqlAdapter,
  resolveMySqlPoolOptions,
  type MySqlColumnMeta,
  type MySqlPool,
  type MySqlRead,
  type MySqlSession,
} from "./mysql-adapter";

// Protocol type codes, spelled out here rather than imported so the spec
// pins the numbers the wire actually carries. mysql2's `Types` enum uses
// the same values.
const TYPE_LONGLONG = 8;
const TYPE_VAR_STRING = 253;
const TYPE_BLOB = 252;
const BINARY_CHARSET = 63;
const UTF8_CHARSET = 255;
const UNSIGNED_FLAG = 32;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function read(
  columns: (string | MySqlColumnMeta)[],
  rows: (Uint8Array | null)[][],
  affectedRows = 0,
): MySqlRead {
  return {
    columns: columns.map((c) => (typeof c === "string" ? { name: c } : c)),
    rows,
    affectedRows,
  };
}

interface Call {
  sql: string;
  values?: readonly unknown[];
}

/** A pool whose every read is answered by a script keyed on the SQL. */
class StubPool implements MySqlPool {
  readonly calls: Call[] = [];
  ended = 0;

  constructor(private readonly answer: (sql: string) => MySqlRead | Error) {}

  async read(sql: string, values?: readonly unknown[]): Promise<MySqlRead> {
    this.calls.push({ sql, values });
    const outcome = this.answer(sql);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }

  session(): Promise<MySqlSession> {
    return Promise.reject(new Error("this stub has no session"));
  }

  async close(): Promise<void> {
    this.ended += 1;
  }
}

/** A one-connection stub for the transaction path. */
class StubSession implements MySqlSession {
  readonly ran: string[] = [];
  released = 0;
  destroyed = 0;

  constructor(
    private readonly failOn?: string,
    private readonly failRollback = false,
  ) {}

  async run(sql: string): Promise<void> {
    this.ran.push(sql);
    if (sql === "ROLLBACK" && this.failRollback) throw new Error("rollback lost the socket");
    if (sql === this.failOn) throw serverError("ER_DUP_ENTRY", "Duplicate entry '1' for key");
  }

  release(): void {
    this.released += 1;
  }

  destroy(): void {
    this.destroyed += 1;
  }
}

class SessionPool implements MySqlPool {
  constructor(readonly session_: StubSession) {}
  read(): Promise<MySqlRead> {
    return Promise.reject(new Error("not used"));
  }
  async session(): Promise<MySqlSession> {
    return this.session_;
  }
  async close(): Promise<void> {}
}

/** A mysql2-shaped error: a server error carries `errno` and `sqlState`. */
function serverError(code: string, message: string, errno = 1062): Error {
  return Object.assign(new Error(message), { code, errno, sqlState: "23000" });
}

/** A mysql2-shaped transport failure: an errno-less Node socket error. */
function socketError(code: string, message: string): Error {
  return Object.assign(new Error(message), { code });
}

const users = { schema: "shop", name: "users" };

describe("MySqlAdapter identity and capabilities", () => {
  const adapter = new MySqlAdapter(new StubPool(() => read([], [])));

  it("reports the driver id the factory registers it under", () => {
    expect(adapter.getId()).toBe("mysql");
  });

  it("advertises exactly the four flags desktop's crate sets", () => {
    // Each flag travels with the method that implements it, per the port's
    // contract. `has_atomic_restore` is true because dbboard's logical dump
    // is data-only (ADR-0049) and an InnoDB transaction is all-or-nothing
    // for data — a DDL statement would implicitly commit, but a dump never
    // emits one.
    expect(adapter.getCapabilities()).toEqual({
      has_views: false,
      has_functions: false,
      has_auth: false,
      has_storage: false,
      has_realtime: false,
      has_describe_table: true,
      has_table_ddl: true,
      has_execute: true,
      has_atomic_restore: true,
    });
  });

  it("implements every optional hook it advertises", () => {
    expect(typeof adapter.describeTable).toBe("function");
    expect(typeof adapter.tableDdl).toBe("function");
    expect(typeof adapter.execute).toBe("function");
    expect(typeof adapter.executeInTransaction).toBe("function");
  });
});

describe("MySqlAdapter.listTables", () => {
  it("reads the qualified name out of information_schema", async () => {
    const pool = new StubPool(() =>
      read(
        ["table_schema", "table_name"],
        [
          [bytes("shop"), bytes("orders")],
          [bytes("shop"), bytes("users")],
        ],
      ),
    );
    const adapter = new MySqlAdapter(pool);

    expect(await adapter.listTables()).toEqual([
      { schema: "shop", name: "orders" },
      { schema: "shop", name: "users" },
    ]);
    // BASE TABLE only, and only the database the connection is bound to —
    // MySQL has no cross-database catalog filter worth guessing at.
    expect(pool.calls[0]?.sql).toContain("table_schema = DATABASE()");
    expect(pool.calls[0]?.sql).toContain("table_type = 'BASE TABLE'");
  });

  it("re-tags a server error as a schema error", async () => {
    // Desktop's `reclassify_schema`: the caller did not write this SQL, so
    // reporting its failure as their query error points at the wrong thing.
    const adapter = new MySqlAdapter(
      new StubPool(() => serverError("ER_PARSE_ERROR", "You have an error in your SQL syntax")),
    );
    await expect(adapter.listTables()).rejects.toBeInstanceOf(SchemaError);
  });

  it("leaves a connection failure a connection failure", async () => {
    // A dead server is not a malformed schema.
    const adapter = new MySqlAdapter(
      new StubPool(() => socketError("ECONNREFUSED", "connect ECONNREFUSED 127.0.0.1:3306")),
    );
    await expect(adapter.listTables()).rejects.toBeInstanceOf(ConnectionError);
  });

  it("refuses a NULL table name rather than inventing one", async () => {
    const adapter = new MySqlAdapter(
      new StubPool(() => read(["table_schema", "table_name"], [[bytes("shop"), null]])),
    );
    await expect(adapter.listTables()).rejects.toBeInstanceOf(SchemaError);
  });
});

describe("MySqlAdapter.executeQuery", () => {
  it("decodes printed bytes as text and keeps invalid UTF-8 as a blob", async () => {
    // Under the text protocol every value arrives as the bytes MySQL would
    // print, so UTF-8 validity — not the declared type — decides.
    const blob = new Uint8Array([0x00, 0xff, 0x0f]);
    const adapter = new MySqlAdapter(
      new StubPool(() => read(["id", "payload", "note"], [[bytes("42"), blob, null]])),
    );

    const result = await adapter.executeQuery("SELECT * FROM t");
    expect(result.rows[0]?.[0]).toBe("42");
    expect(isBlobValue(result.rows[0]?.[1])).toBe(true);
    expect(decodeBlob(result.rows[0]?.[1] as never)).toEqual(blob);
    expect(result.rows[0]?.[2]).toBeNull();
  });

  it("names the declared type from the protocol type code", async () => {
    const adapter = new MySqlAdapter(
      new StubPool(() =>
        read(
          [
            { name: "id", type: TYPE_LONGLONG, flags: UNSIGNED_FLAG },
            { name: "label", type: TYPE_VAR_STRING, characterSet: UTF8_CHARSET },
            { name: "raw", type: TYPE_BLOB, characterSet: BINARY_CHARSET },
            { name: "body", type: TYPE_BLOB, characterSet: UTF8_CHARSET },
            { name: "mystery" },
          ],
          [],
        ),
      ),
    );

    expect((await adapter.executeQuery("SELECT 1")).columns).toEqual([
      { name: "id", declared_type: "BIGINT UNSIGNED" },
      { name: "label", declared_type: "VARCHAR" },
      // The binary character set is what tells BLOB apart from TEXT — the
      // protocol gives both the same type code.
      { name: "raw", declared_type: "BLOB" },
      { name: "body", declared_type: "TEXT" },
      // A code this map does not know is reported as no type rather than
      // as a wrong one.
      { name: "mystery", declared_type: null },
    ]);
  });

  it("reports the affected count for a write and zero for a read", async () => {
    const write = new MySqlAdapter(new StubPool(() => read([], [], 3)));
    expect((await write.executeQuery("DELETE FROM t")).rows_affected).toBe(3);

    // A row-returning statement reports 0, as desktop does: `rows_affected`
    // is load-bearing on DML only.
    const select = new MySqlAdapter(new StubPool(() => read(["id"], [[bytes("1")]], 7)));
    expect((await select.executeQuery("SELECT id FROM t")).rows_affected).toBe(0);
  });

  it("reports a server error as the caller's query error", async () => {
    const adapter = new MySqlAdapter(
      new StubPool(() => serverError("ER_NO_SUCH_TABLE", "Table 'shop.nope' doesn't exist", 1146)),
    );
    await expect(adapter.executeQuery("SELECT 1")).rejects.toBeInstanceOf(QueryError);
  });

  it("reports a refused login as a connection error, not a query error", async () => {
    // A divergence from desktop, which classifies every server-reported
    // error as `Query`. Web's house rule (see `turso-adapter.ts`) is that a
    // credential problem is about the connection: reporting it as a 400
    // blames SQL the user may not even have run yet.
    const adapter = new MySqlAdapter(
      new StubPool(() =>
        serverError("ER_ACCESS_DENIED_ERROR", "Access denied for user 'app'@'10.0.0.1'", 1045),
      ),
    );
    await expect(adapter.executeQuery("SELECT 1")).rejects.toBeInstanceOf(ConnectionError);
  });

  it("scrubs the connection password out of a transport message", async () => {
    const adapter = new MySqlAdapter(
      new StubPool(() => socketError("ECONNRESET", "socket hang up (mysql://app:s3cr3t@db/shop)")),
      "s3cr3t",
    );
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/\*\*\*/);
    await expect(adapter.executeQuery("SELECT 1")).rejects.not.toThrow(/s3cr3t/);
  });

  it("caps how much of a hostile message reaches the client", async () => {
    const adapter = new MySqlAdapter(new StubPool(() => serverError("ER_X", "x".repeat(5000))));
    await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/…$/);
  });
});

describe("MySqlAdapter.describeTable", () => {
  const columnsRead = read(
    ["column_name", "column_type", "is_nullable", "column_default", "ordinal_position"],
    [
      [bytes("id"), bytes("bigint unsigned"), bytes("NO"), null, bytes("1")],
      [bytes("email"), bytes("varchar(255)"), bytes("yes"), bytes("''"), bytes("2")],
    ],
  );
  const pkRead = read(["column_name"], [[bytes("id")]]);

  const script = (sql: string): MySqlRead =>
    sql.includes("key_column_usage") ? pkRead : columnsRead;

  it("binds the schema and table and falls back to the current database", async () => {
    const pool = new StubPool(script);
    await new MySqlAdapter(pool).describeTable(users);

    expect(pool.calls[0]?.sql).toContain("COALESCE(?, DATABASE())");
    expect(pool.calls[0]?.values).toEqual(["shop", "users"]);
    // An unqualified table binds NULL so COALESCE picks the current
    // database, rather than the adapter guessing a schema name.
    const unqualified = new StubPool(script);
    await new MySqlAdapter(unqualified).describeTable({ schema: null, name: "users" });
    expect(unqualified.calls[0]?.values).toEqual([null, "users"]);
  });

  it("maps the catalog rows onto the contract's column shape", async () => {
    const schema = await new MySqlAdapter(new StubPool(script)).describeTable(users);

    expect(schema.primary_key).toEqual(["id"]);
    expect(schema.columns).toEqual([
      {
        name: "id",
        declared_type: "bigint unsigned",
        nullable: false,
        primary_key: true,
        ordinal: 1,
        default_value: null,
      },
      {
        // "yes" lower-case: the SQL-standard spelling is "YES", compared
        // case-insensitively because not every server agrees on the case.
        name: "email",
        declared_type: "varchar(255)",
        nullable: true,
        primary_key: false,
        ordinal: 2,
        default_value: "''",
      },
    ]);
  });

  it("reports an unknown table as a query error", async () => {
    // information_schema answers an unknown table with an empty set rather
    // than an error, and a table with no columns cannot be told apart from
    // a missing one.
    const adapter = new MySqlAdapter(new StubPool(() => read([], [])));
    await expect(adapter.describeTable(users)).rejects.toThrow(/table `users` does not exist/);
    await expect(adapter.describeTable(users)).rejects.toBeInstanceOf(QueryError);
  });

  it("refuses a non-positive ordinal rather than sorting by a silent NaN", async () => {
    const adapter = new MySqlAdapter(
      new StubPool((sql) =>
        sql.includes("key_column_usage")
          ? read(["column_name"], [])
          : read(
              ["column_name", "column_type", "is_nullable", "column_default", "ordinal_position"],
              [[bytes("id"), bytes("int"), bytes("NO"), null, bytes("0")]],
            ),
      ),
    );
    await expect(adapter.describeTable(users)).rejects.toBeInstanceOf(TypeConversionError);
  });

  it("refuses metadata that is not valid UTF-8", async () => {
    // Unlike a result cell, an identifier that is not text has no useful
    // representation in a TableSchema — handing back a blob would give the
    // caller a name it cannot address the object with.
    const adapter = new MySqlAdapter(
      new StubPool(() =>
        read(
          ["column_name", "column_type", "is_nullable", "column_default", "ordinal_position"],
          [[new Uint8Array([0xff]), bytes("int"), bytes("NO"), null, bytes("1")]],
        ),
      ),
    );
    await expect(adapter.describeTable(users)).rejects.toBeInstanceOf(SchemaError);
  });

  it("keeps the primary key in key order", async () => {
    const pool = new StubPool((sql) =>
      sql.includes("key_column_usage")
        ? read(["column_name"], [[bytes("tenant")], [bytes("id")]])
        : read(
            ["column_name", "column_type", "is_nullable", "column_default", "ordinal_position"],
            [
              [bytes("id"), bytes("int"), bytes("NO"), null, bytes("1")],
              [bytes("tenant"), bytes("int"), bytes("NO"), null, bytes("2")],
            ],
          ),
    );
    const schema = await new MySqlAdapter(pool).describeTable(users);
    // Key order, not column order: it differs for composite keys and is
    // unrecoverable once lost.
    expect(schema.primary_key).toEqual(["tenant", "id"]);
    expect(schema.columns.every((c) => c.primary_key)).toBe(true);
    // `ORDER BY ordinal_position` on the key query would be the column
    // order; the query orders by the key position instead.
    expect(pool.calls.find((c) => c.sql.includes("key_column_usage"))?.sql).toContain(
      "constraint_name = 'PRIMARY'",
    );
  });
});

describe("MySqlAdapter.tableDdl", () => {
  it("reads the statement out of SHOW CREATE TABLE's second column", async () => {
    // Column 0 is the table name. Reading it would emit a dump whose every
    // CREATE statement is the word `users`.
    const pool = new StubPool(() =>
      read(["Table", "Create Table"], [[bytes("users"), bytes("CREATE TABLE `users` (…)")]]),
    );
    expect(await new MySqlAdapter(pool).tableDdl(users)).toBe("CREATE TABLE `users` (…)");
    expect(pool.calls[0]?.sql).toBe("SHOW CREATE TABLE `shop`.`users`");
  });

  it("back-quotes an unqualified table and doubles an embedded back-tick", async () => {
    // SHOW takes no placeholders, so the identifier is interpolated — a
    // hostile name must not be able to break out of it.
    const pool = new StubPool(() =>
      read(["Table", "Create Table"], [[bytes("x"), bytes("CREATE TABLE x")]]),
    );
    await new MySqlAdapter(pool).tableDdl({ schema: null, name: "we`ird" });
    expect(pool.calls[0]?.sql).toBe("SHOW CREATE TABLE `we``ird`");
  });

  it("reports a missing table as a query error", async () => {
    const pool = new StubPool(() => read(["Table", "Create Table"], []));
    await expect(new MySqlAdapter(pool).tableDdl(users)).rejects.toBeInstanceOf(QueryError);
  });
});

describe("MySqlAdapter.execute", () => {
  it("returns the affected count", async () => {
    const adapter = new MySqlAdapter(new StubPool(() => read([], [], 2)));
    expect(await adapter.execute("UPDATE t SET a = 1")).toBe(2);
  });
});

describe("MySqlAdapter.executeInTransaction", () => {
  it("wraps the batch in one transaction on one connection", async () => {
    const session = new StubSession();
    await new MySqlAdapter(new SessionPool(session)).executeInTransaction(["INSERT 1", "INSERT 2"]);
    expect(session.ran).toEqual(["BEGIN", "INSERT 1", "INSERT 2", "COMMIT"]);
    expect(session.released).toBe(1);
    expect(session.destroyed).toBe(0);
  });

  it("does nothing at all for an empty batch", async () => {
    const session = new StubSession();
    await new MySqlAdapter(new SessionPool(session)).executeInTransaction([]);
    expect(session.ran).toEqual([]);
  });

  it("rolls back and reports the statement's failure, not the rollback's", async () => {
    const session = new StubSession("INSERT 2");
    await expect(
      new MySqlAdapter(new SessionPool(session)).executeInTransaction(["INSERT 1", "INSERT 2"]),
    ).rejects.toThrow(/Duplicate entry/);
    expect(session.ran).toEqual(["BEGIN", "INSERT 1", "INSERT 2", "ROLLBACK"]);
    expect(session.released).toBe(1);
  });

  it("destroys a connection whose rollback did not land", async () => {
    // Returning it to the pool would hand the next caller a session with an
    // open transaction on it.
    const session = new StubSession("INSERT 1", true);
    await expect(
      new MySqlAdapter(new SessionPool(session)).executeInTransaction(["INSERT 1"]),
    ).rejects.toThrow(/Duplicate entry/);
    expect(session.destroyed).toBe(1);
    expect(session.released).toBe(0);
  });
});

describe("MySqlAdapter.close", () => {
  it("ends the pool", async () => {
    const pool = new StubPool(() => read([], []));
    await new MySqlAdapter(pool).close();
    expect(pool.ended).toBe(1);
  });
});

describe("resolveMySqlPoolOptions", () => {
  it("splits a URL into the fields the driver takes", () => {
    expect(resolveMySqlPoolOptions("mysql://app:s3cr3t@db.internal:3307/shop")).toMatchObject({
      host: "db.internal",
      port: 3307,
      user: "app",
      password: "s3cr3t",
      database: "shop",
    });
  });

  it("defaults the port and percent-decodes the credential", () => {
    const opts = resolveMySqlPoolOptions("mysql://us%40er:p%40ss%2Fword@localhost/shop");
    expect(opts.port).toBe(3306);
    expect(opts.user).toBe("us@er");
    expect(opts.password).toBe("p@ss/word");
  });

  it("unwraps an IPv6 host", () => {
    // `URL.hostname` keeps the brackets; the driver wants the address.
    expect(resolveMySqlPoolOptions("mysql://[::1]:3306/shop").host).toBe("::1");
  });

  it("accepts a mariadb URL", () => {
    expect(resolveMySqlPoolOptions("mariadb://localhost/shop").host).toBe("localhost");
  });

  it("upgrades the unstated TLS policy to an encrypted connection", () => {
    // The whole point. sqlx defaults to `Preferred`, which silently falls
    // back to plaintext and sends the password in the clear; mysql2's own
    // default is no TLS at all. Both are the failure this hardens.
    // `rejectUnauthorized: false` is what `required` means — encrypt, do
    // not verify — because there is nowhere to nominate a CA yet.
    expect(resolveMySqlPoolOptions("mysql://localhost/shop").ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolveMySqlPoolOptions("mysql://localhost/shop?ssl-mode=PREFERRED").ssl).toEqual({
      rejectUnauthorized: false,
    });
    expect(resolveMySqlPoolOptions("mysql://localhost/shop?ssl-mode=REQUIRED").ssl).toEqual({
      rejectUnauthorized: false,
    });
  });

  it("preserves an explicit choice in either direction", () => {
    // A deliberately insecure local node stays insecure, and a request to
    // verify is honoured rather than quietly downgraded.
    expect(resolveMySqlPoolOptions("mysql://localhost/shop?ssl-mode=DISABLED").ssl).toBeUndefined();
    expect(resolveMySqlPoolOptions("mysql://localhost/shop?ssl-mode=VERIFY_CA").ssl).toEqual({
      rejectUnauthorized: true,
    });
    expect(resolveMySqlPoolOptions("mysql://localhost/shop?ssl-mode=verify_identity").ssl).toEqual({
      rejectUnauthorized: true,
    });
  });

  it("refuses a URL it cannot make sense of, without echoing it", () => {
    // Desktop reduces sqlx's `Configuration` error to a fixed string for
    // exactly this reason: the source may embed the password.
    for (const bad of ["", "   ", "not a url", "postgresql://app:s3cr3t@db/shop"]) {
      expect(() => resolveMySqlPoolOptions(bad)).toThrow(CapabilityError);
      expect(() => resolveMySqlPoolOptions(bad)).not.toThrow(/s3cr3t/);
    }
  });

  it("refuses an ssl-mode it does not implement", () => {
    expect(() => resolveMySqlPoolOptions("mysql://localhost/shop?ssl-mode=NONSENSE")).toThrow(
      CapabilityError,
    );
  });

  it("refuses a URL with no host", () => {
    expect(() => resolveMySqlPoolOptions("mysql:///shop")).toThrow(CapabilityError);
  });
});

describe("createMySqlAdapter", () => {
  it("refuses a config with no connection string", () => {
    // CapabilityError, not a 500: the request named a driver this server
    // has, configured in a way it cannot serve. Surfaces as 404, matching
    // the other factories.
    expect(() => createMySqlAdapter({})).toThrow(CapabilityError);
    expect(() => createMySqlAdapter({ connectionString: "  " })).toThrow(CapabilityError);
  });

  it("builds an adapter from a well-formed URL", () => {
    // mysql2's pool is lazy — no socket until the first statement — so
    // this is safe to call at registration time.
    const adapter = createMySqlAdapter({ connectionString: "mysql://app:pw@localhost/shop" });
    expect(adapter.getId()).toBe("mysql");
  });
});

describe("carryMySqlCredential", () => {
  // ADR-0080 decision 3: the browser is shown where a connection points but
  // never the credential, so a save that left the password box alone arrives
  // with no password. That is an omission, not a removal.
  const stored = "mysql://app:s3cr3t@old.example:3306/shop";

  it("keeps the stored password when the edited URL states none", () => {
    const merged = carryMySqlCredential(stored, "mysql://app@new.example/shop");
    expect(resolveMySqlPoolOptions(merged)).toMatchObject({
      host: "new.example",
      password: "s3cr3t",
    });
  });

  it("takes a newly stated password over the stored one", () => {
    const merged = carryMySqlCredential(stored, "mysql://app:fresh@old.example/shop");
    expect(resolveMySqlPoolOptions(merged).password).toBe("fresh");
  });

  it("percent-encodes a grafted password that needs it", () => {
    // Grafting through the URL object rather than by string surgery is what
    // makes a password containing `@` or `/` survive being re-parsed.
    const merged = carryMySqlCredential(
      "mysql://app:p%40ss%2Fword@old/shop",
      "mysql://app@new/shop",
    );
    expect(resolveMySqlPoolOptions(merged).password).toBe("p@ss/word");
  });

  it("passes an unparseable edit through for the factory to report", () => {
    // One error for one cause: this function inventing a second would mean
    // two different messages for the same bad URL.
    expect(carryMySqlCredential(stored, "not a url")).toBe("not a url");
  });
});

describe("MySqlAdapter.rebuildWith", () => {
  it("carries the stored password into the rebuilt adapter", async () => {
    const original = createMySqlAdapter({ connectionString: "mysql://app:s3cr3t@old/shop" });
    // Would throw if the password had been dropped and the URL re-parsed
    // without it — `rebuildWith` runs the edited URL through the factory.
    const moved = original.rebuildWith({ connectionString: "mysql://app@new/shop" });
    expect(moved.getId()).toBe("mysql");
    await original.close();
    await moved.close();
  });
});
