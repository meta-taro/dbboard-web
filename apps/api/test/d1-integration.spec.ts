import { describe, expect, it } from "vitest";
import { createD1Adapter, type D1Adapter } from "../src/infrastructure/d1-adapter";
import { isBlobValue } from "../src/domain/values/value";

// Live round-trip against a real Cloudflare D1 database — the web mirror of
// desktop's `crates/dbboard-d1/tests/rest_roundtrip.rs`, and the only test in
// the slice that talks to the API this adapter was written for. Everything
// else stubs the transport, which proves the adapter handles the envelope
// Cloudflare documents; this proves the envelope is the one Cloudflare sends.
//
// Network-bound, so it self-skips unless all three variables are set:
//
//   DBBOARD_D1_ACCOUNT_ID   DBBOARD_D1_DATABASE_ID   DBBOARD_D1_TOKEN
//
// Same names as desktop, so one shell exports both suites. Unlike the
// Postgres suite there is no container to fall back on: D1 has no local
// implementation, and a stub of the REST API would be this file testing the
// stub. Baseline §15 puts the credential in the maintainer's hands — an
// agent neither holds nor sets it — so an unset run is the normal one, and
// the skip prints why rather than passing silently.
//
// Every table it creates is named for the process, so a repeated run against
// a shared database does not collide with a run still in flight.

const ACCOUNT_ID = process.env.DBBOARD_D1_ACCOUNT_ID;
const DATABASE_ID = process.env.DBBOARD_D1_DATABASE_ID;
const TOKEN = process.env.DBBOARD_D1_TOKEN;

const LIVE = Boolean(ACCOUNT_ID && DATABASE_ID && TOKEN);
const SUITE_TIMEOUT_MS = 60_000;

function adapter(): D1Adapter {
  return createD1Adapter({
    accountId: ACCOUNT_ID,
    databaseId: DATABASE_ID,
    authToken: TOKEN,
  });
}

const TABLE = `dbboard_d1_web_${process.pid}`;

describe("D1 adapter integration (live REST)", () => {
  if (!LIVE) {
    // A skipped assertion rather than a bare `describe.skip`, so the reason
    // reaches whoever wondered why the suite was quiet.
    it.skip("skipped: DBBOARD_D1_ACCOUNT_ID / _DATABASE_ID / _TOKEN not set", () => {});
    return;
  }

  it(
    "round-trips a SELECT",
    async () => {
      const result = await adapter().executeQuery("SELECT 1 AS one");

      expect(result.columns.map((c) => c.name)).toEqual(["one"]);
      expect(result.rows).toEqual([[1]]);
      // /raw reports no declared type for any column, which is what the
      // adapter's `declared_type: null` is mirroring rather than losing.
      expect(result.columns[0].declared_type).toBeNull();
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "lists tables against a database that may hold none",
    async () => {
      // `sqlite_master` always exists, so this succeeds on an empty database.
      // Asserting only that it resolves: the contents are the operator's.
      await expect(adapter().listTables()).resolves.toBeInstanceOf(Array);
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "round-trips storage classes, DDL and a describe through one table",
    async () => {
      const d1 = adapter();

      await d1.execute(`DROP TABLE IF EXISTS ${TABLE}`);
      await d1.execute(
        `CREATE TABLE ${TABLE} (id INTEGER PRIMARY KEY, label TEXT NOT NULL, ratio REAL, payload BLOB)`,
      );

      try {
        const changed = await d1.execute(
          `INSERT INTO ${TABLE} (id, label, ratio, payload) VALUES (1, 'one', 0.5, x'00ff')`,
        );
        expect(changed).toBe(1);

        const rows = await d1.executeQuery(
          `SELECT id, label, ratio, payload FROM ${TABLE} ORDER BY id`,
        );
        const [id, label, ratio, payload] = rows.rows[0];
        expect(id).toBe(1);
        expect(label).toBe("one");
        expect(ratio).toBe(0.5);
        // The one mapping with no counterpart in the native driver: D1 sends
        // a BLOB as an array of byte numbers.
        expect(isBlobValue(payload)).toBe(true);

        const schema = await d1.describeTable({ schema: null, name: TABLE });
        expect(schema.columns.map((c) => c.name)).toEqual(["id", "label", "ratio", "payload"]);
        expect(schema.columns[0].ordinal).toBe(1);
        expect(schema.primary_key).toEqual(["id"]);
        expect(schema.columns[1].nullable).toBe(false);

        const ddl = await d1.tableDdl({ schema: null, name: TABLE });
        expect(ddl).toContain(`CREATE TABLE ${TABLE}`);
        expect(ddl.endsWith(";\n")).toBe(true);
      } finally {
        await d1.execute(`DROP TABLE IF EXISTS ${TABLE}`);
      }
    },
    SUITE_TIMEOUT_MS,
  );

  it(
    "reports a bad statement as a query error, not a connection error",
    async () => {
      // The classification the error taxonomy turns on: a 400 from a typo
      // must not read as an unreachable database.
      await expect(adapter().executeQuery("SELECT * FROM definitely_not_a_table")).rejects.toThrow(
        /no such table/i,
      );
    },
    SUITE_TIMEOUT_MS,
  );
});
