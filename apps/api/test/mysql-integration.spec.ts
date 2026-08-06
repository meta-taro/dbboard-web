import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMySqlAdapter, type MySqlAdapter } from "../src/infrastructure/mysql-adapter";
import { isBlobValue } from "../src/domain/values/value";
import { QueryError } from "../src/domain/errors";

// Live round-trip against a real MySQL-wire server — the web mirror of
// desktop's `crates/dbboard-mysql/tests/mysql_roundtrip.rs` (ADR-0068).
//
// Two ways in, and the order matters:
//
//   1. `DBBOARD_MYSQL_URL`, if set. Same variable name desktop uses, so one
//      shell exports both suites, and the only way to point the tests at a
//      MariaDB or a PlanetScale branch rather than at MySQL 8.
//   2. Otherwise a `mysql:8` container via testcontainers.
//
// The container is the difference from the D1 suite, which self-skips when
// its credential is absent because Cloudflare has no local implementation.
// MySQL does, so a credential-less run still exercises the adapter — the
// same call the Postgres suite makes, for the same reason. Baseline §15
// keeps a real server's URL in the maintainer's hands; nothing here needs
// one to be meaningful.
//
// What it proves that `mysql-adapter.spec.ts` cannot: that the bytes the
// stub hands the adapter are the bytes MySQL sends. Every assertion below
// about the *text* protocol is really an assertion about the two options
// `Mysql2Pool` passes down — `query` rather than `execute`, and a
// `typeCast` that returns the raw buffer. Swap either and a stubbed test
// stays green while this one stops being true.

const SUITE_TIMEOUT_MS = 180_000;
const STARTUP_TIMEOUT_MS = 120_000;
const ROOT_PASSWORD = "test";

// Named for the process, so a repeated run against a shared server does not
// collide with a run still in flight.
const TABLE = `dbboard_mysql_web_${process.pid}`;

describe("MySQL adapter integration", () => {
  let container: StartedTestContainer | null = null;
  let adapter: MySqlAdapter | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    const external = process.env.DBBOARD_MYSQL_URL;
    if (external) {
      adapter = createMySqlAdapter({ connectionString: external });
      return;
    }

    try {
      container = await new GenericContainer("mysql:8")
        .withEnvironment({
          MYSQL_ROOT_PASSWORD: ROOT_PASSWORD,
          MYSQL_DATABASE: "test",
        })
        .withExposedPorts(3306)
        .withStartupTimeout(STARTUP_TIMEOUT_MS)
        .start();
    } catch (e) {
      skipReason = `Docker not available (${e instanceof Error ? e.message : String(e)})`;
      console.warn(`[mysql-integration] SKIPPING: ${skipReason}`);
      return;
    }

    // `ssl-mode=DISABLED` for the same reason the Postgres suite disables
    // TLS: the stock image serves a self-signed certificate the adapter's
    // default (`rejectUnauthorized: false`) would in fact accept, but
    // spelling the opt-out here keeps the connection identical to the
    // tunnelled/loopback case the option exists for, and makes a future
    // change to that default visible as a failure rather than as silence.
    const host = container.getHost();
    const port = container.getMappedPort(3306);
    adapter = createMySqlAdapter({
      connectionString: `mysql://root:${ROOT_PASSWORD}@${host}:${port}/test?ssl-mode=DISABLED`,
    });
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    if (adapter) await adapter.close();
    if (container) await container.stop();
  }, SUITE_TIMEOUT_MS);

  /**
   * The adapter, or a `ctx.skip()` when there is no server to talk to.
   *
   * A helper rather than a bare `describe.skip`, because the skip is decided
   * in `beforeAll` — Docker's absence is not known until the daemon has been
   * asked. Returning `null` lets each test bail with the reason attached.
   */
  function live(ctx: { skip: () => void }): MySqlAdapter {
    if (!adapter) {
      ctx.skip();
      throw new Error(skipReason ?? "no MySQL server");
    }
    return adapter;
  }

  it(
    "round-trips a SELECT with every value in printed text form",
    async (ctx) => {
      const my = live(ctx);
      // The wire-protocol regression, and the whole reason `Mysql2Pool`
      // calls `query` instead of `execute`: the text protocol hands back
      // what MySQL would print. Under the binary protocol an INT arrives as
      // four raw bytes, `decodeUtf8` rejects them, and the cell silently
      // becomes a blob instead of "42".
      const result = await my.executeQuery(
        "SELECT CAST(42 AS SIGNED) AS small, " +
          "CAST(1234567890123 AS SIGNED) AS wide, " +
          "CAST('2026-07-30 12:34:56' AS DATETIME) AS ts",
      );

      expect(result.columns.map((c) => c.name)).toEqual(["small", "wide", "ts"]);
      expect(result.rows).toEqual([["42", "1234567890123", "2026-07-30 12:34:56"]]);
      // An integer wider than MAX_SAFE_INTEGER is not a special case here
      // the way it is on Postgres: nothing is ever parsed into a number, so
      // nothing can lose precision on the way.
      expect(result.rows_affected).toBe(0);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "reports the declared type MySQL sent, not the one it inferred",
    async (ctx) => {
      const my = live(ctx);
      // `typeNameOf` reads the protocol type code and the charset, so this
      // is the one assertion that the code table is aimed at the right
      // fields of mysql2's column metadata.
      const result = await my.executeQuery(
        "SELECT CAST(1 AS SIGNED) AS i, 'x' AS s, CAST('x' AS BINARY) AS b",
      );
      const declared = result.columns.map((c) => c.declared_type);
      expect(declared[0]).toBe("BIGINT");
      expect(declared[1]).toBe("VARCHAR");
      // Same type code as the column before it; only the charset says which.
      expect(declared[2]).toBe("VARBINARY");
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "round-trips DML, NULL, blobs and introspection through one table",
    async (ctx) => {
      const my = live(ctx);
      await my.execute(`DROP TABLE IF EXISTS \`${TABLE}\``);
      await my.execute(
        `CREATE TABLE \`${TABLE}\` (` +
          `id INT PRIMARY KEY, ` +
          `name VARCHAR(255), ` +
          `note BLOB, ` +
          `raw BLOB)`,
      );

      try {
        const changed = await my.execute(
          `INSERT INTO \`${TABLE}\` (id, name, note, raw) VALUES ` +
            `(1, 'alice', 'plain text', 0x00FF), ` +
            `(2, NULL, NULL, NULL)`,
        );
        expect(changed).toBe(2);

        const rows = await my.executeQuery(
          `SELECT id, name, note, raw FROM \`${TABLE}\` ORDER BY id`,
        );
        expect(rows.rows).toHaveLength(2);
        expect(rows.rows[0][0]).toBe("1");
        expect(rows.rows[0][1]).toBe("alice");
        // The rule that makes reading cells as bytes worth the trouble: a
        // BLOB whose contents happen to be valid UTF-8 is text, and one
        // whose contents are not is a blob. The declared type decides
        // neither — which is exactly what mysql2's default typeCast would
        // have used.
        expect(rows.rows[0][2]).toBe("plain text");
        expect(isBlobValue(rows.rows[0][3])).toBe(true);
        // NULL stays null rather than becoming the string "NULL" or an
        // empty blob.
        expect(rows.rows[1][1]).toBeNull();
        expect(rows.rows[1][2]).toBeNull();

        const tables = await my.listTables();
        expect(tables.map((t) => t.name)).toContain(TABLE);
        // `information_schema` is a data-dictionary view since MySQL 8, so
        // `table_name` arrives as VARBINARY — the name being a string here
        // is the metadata decode working, not a formality.
        expect(tables.every((t) => typeof t.name === "string")).toBe(true);
      } finally {
        await my.execute(`DROP TABLE IF EXISTS \`${TABLE}\``);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "describes columns in ordinal order with a composite key in key order",
    async (ctx) => {
      const my = live(ctx);
      const table = `${TABLE}_describe`;
      await my.execute(`DROP TABLE IF EXISTS \`${table}\``);
      // VARCHAR, not TEXT: MySQL rejects a literal DEFAULT on a TEXT column.
      await my.execute(
        `CREATE TABLE \`${table}\` (` +
          `order_id INT NOT NULL, ` +
          `line_no INT NOT NULL, ` +
          `sku VARCHAR(255) NOT NULL DEFAULT 'unknown', ` +
          `PRIMARY KEY (order_id, line_no))`,
      );

      try {
        const schema = await my.describeTable({ schema: null, name: table });

        expect(schema.columns.map((c) => c.name)).toEqual(["order_id", "line_no", "sku"]);
        expect(schema.columns.map((c) => c.ordinal)).toEqual([1, 2, 3]);
        // Key order, not column order — `key_column_usage` orders by its own
        // ordinal, which is the position within the key.
        expect(schema.primary_key).toEqual(["order_id", "line_no"]);

        const sku = schema.columns[2];
        expect(sku.nullable).toBe(false);
        expect(sku.primary_key).toBe(false);
        expect(sku.default_value).toContain("unknown");
      } finally {
        await my.execute(`DROP TABLE IF EXISTS \`${table}\``);
      }

      // A dropped table is a query error, not an empty schema: the column
      // set being empty is how the adapter learns the table is gone, and
      // returning `{ columns: [] }` would render as a table with no columns.
      await expect(my.describeTable({ schema: null, name: table })).rejects.toBeInstanceOf(
        QueryError,
      );
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "reads SHOW CREATE TABLE back through a multi-byte identifier",
    async (ctx) => {
      const my = live(ctx);
      const table = `${TABLE}_ddl`;
      await my.execute(`DROP TABLE IF EXISTS \`${table}\``);
      // `SHOW` takes no expressions, so there is no `CAST(… AS CHAR)` to
      // fall back on if the server answers under a binary type. Reading the
      // cell as bytes is the only way through, and a multi-byte column name
      // is what proves those bytes were decoded rather than mangled.
      await my.execute(
        `CREATE TABLE \`${table}\` (id INT NOT NULL PRIMARY KEY, \`点検日\` DATE NULL)`,
      );

      try {
        const ddl = await my.tableDdl({ schema: null, name: table });
        expect(ddl).toContain(table);
        expect(ddl).toContain("点検日");
      } finally {
        await my.execute(`DROP TABLE IF EXISTS \`${table}\``);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "rolls a failed transaction back whole",
    async (ctx) => {
      const my = live(ctx);
      const table = `${TABLE}_tx`;
      await my.execute(`DROP TABLE IF EXISTS \`${table}\``);
      await my.execute(`CREATE TABLE \`${table}\` (id INT PRIMARY KEY) ENGINE=InnoDB`);

      try {
        await expect(
          my.executeInTransaction([
            `INSERT INTO \`${table}\` (id) VALUES (1)`,
            `INSERT INTO \`${table}\` (id) VALUES (1)`,
          ]),
        ).rejects.toBeInstanceOf(QueryError);

        // The first insert must be gone too. InnoDB is named explicitly
        // because MyISAM would leave it behind and the rollback would look
        // like it worked at the adapter level while losing the guarantee.
        const rows = await my.executeQuery(`SELECT COUNT(*) FROM \`${table}\``);
        expect(rows.rows[0][0]).toBe("0");

        // The connection survives the rollback: a pooled session that was
        // destroyed instead of released would surface here as a hang or a
        // fresh connect, not as an error.
        await my.executeInTransaction([`INSERT INTO \`${table}\` (id) VALUES (2)`]);
        const after = await my.executeQuery(`SELECT id FROM \`${table}\``);
        expect(after.rows).toEqual([["2"]]);
      } finally {
        await my.execute(`DROP TABLE IF EXISTS \`${table}\``);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "reports a bad statement as a query error, not a connection error",
    async (ctx) => {
      const my = live(ctx);
      // The classification the error taxonomy turns on: a typo must not
      // read as an unreachable server, because the two lead an operator to
      // opposite places.
      await expect(
        my.executeQuery("SELECT * FROM definitely_not_a_table_here"),
      ).rejects.toBeInstanceOf(QueryError);
    },
    SUITE_TIMEOUT_MS,
  );
});
