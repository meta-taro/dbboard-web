import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPostgresAdapter } from "../src/infrastructure/postgres-adapter";
import { createApp } from "../src/main";

// Integration test for the Postgres adapter (ticket 0004 § Tests).
//
// Boots a real `postgres:16-alpine` via testcontainers, registers a
// connection through the HTTP surface, and asserts each row in the
// type-mapping table (.claude/issues/0004-postgres-adapter.md) decodes
// correctly through the full stack: Controller → use case → adapter →
// pgOidToValue → Value.
//
// Skip gate (per ticket): if Docker is not reachable, every test calls
// `ctx.skip()` so the suite reports SKIPPED with a clear console
// message instead of failing. Local dev without Docker, CI without a
// daemon, and Windows hosts where `DOCKER_HOST` is unset all hit this
// gate gracefully.

const SUITE_TIMEOUT_MS = 180_000;
const STARTUP_TIMEOUT_MS = 120_000;

describe("Postgres adapter integration (testcontainers)", () => {
  let container: StartedTestContainer | null = null;
  let app: INestApplication | null = null;
  let connectionId: string | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    try {
      container = await new GenericContainer("postgres:16-alpine")
        .withEnvironment({
          POSTGRES_PASSWORD: "test",
          POSTGRES_DB: "test",
          POSTGRES_USER: "test",
        })
        .withExposedPorts(5432)
        .withStartupTimeout(STARTUP_TIMEOUT_MS)
        .start();
    } catch (e) {
      skipReason = `Docker not available (${e instanceof Error ? e.message : String(e)})`;

      console.warn(`[postgres-integration] SKIPPING: ${skipReason}`);
      return;
    }

    app = await createApp();
    await app.init();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    // `sslmode=disable` is required, not incidental. `postgres:16-alpine`
    // ships with TLS unconfigured, and since 0027 slice A an unqualified
    // URL resolves to `require` — so without the opt-out the container
    // refuses the SSLRequest and every test here fails to connect. This is
    // the tunnelled/loopback case from ADR-0078 § Context, and typing the
    // opt-out is the intended answer to it.
    const connectionString = `postgresql://test:test@${host}:${port}/test?sslmode=disable`;

    const reg = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "tc-pg", driver: "postgres", connectionString });

    if (reg.status !== 201) {
      throw new Error(
        `Failed to register postgres connection: ${reg.status} ${JSON.stringify(reg.body)}`,
      );
    }
    connectionId = reg.body.id as string;
  }, SUITE_TIMEOUT_MS);

  afterAll(async () => {
    if (app) await app.close();
    if (container) await container.stop();
  }, SUITE_TIMEOUT_MS);

  async function runQuery(sql: string): Promise<{ status: number; body: unknown }> {
    if (!app || !connectionId) {
      throw new Error("Suite not initialised");
    }
    const res = await request(app.getHttpServer())
      .post(`/connections/${connectionId}/query`)
      .set("Content-Type", "application/json")
      .send({ sql });
    return { status: res.status, body: res.body };
  }

  function firstCell(body: unknown): unknown {
    const b = body as { rows?: unknown[][] };
    if (!b.rows || b.rows.length === 0 || !b.rows[0]) {
      throw new Error(`Expected at least one row in ${JSON.stringify(body)}`);
    }
    return b.rows[0][0];
  }

  // ---- one test per type-mapping row -------------------------------

  it("int2 → Integer(number)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 42::int2 AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe(42);
  });

  it("int4 → Integer(number)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 2147483647::int4 AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe(2147483647);
  });

  it("int8 within safe range → Integer(number)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 9007199254740991::int8 AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe(9007199254740991);
  });

  it("int8 above MAX_SAFE_INTEGER → Text(string) (lossy guard)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 9223372036854775807::int8 AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("9223372036854775807");
  });

  it("float4 → Real(number)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 1.5::float4 AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe(1.5);
  });

  it("float8 → Real(number)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 3.14159265358979::float8 AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBeCloseTo(3.14159265358979, 12);
  });

  it("numeric that round-trips → Real(number)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 1.5::numeric AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe(1.5);
  });

  it("numeric with trailing-zero precision → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    // "1.20" cannot round-trip through JS number (becomes "1.2"); decoder
    // preserves the original text so the UI shows the real precision.
    const { status, body } = await runQuery("SELECT 1.20::numeric AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("1.20");
  });

  it("bool true → Integer(1)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT true AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe(1);
  });

  it("bool false → Integer(0)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT false AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe(0);
  });

  it("bytea → Blob({ $blob: base64 })", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT decode('deadbeef', 'hex') AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toEqual({ $blob: Buffer.from("deadbeef", "hex").toString("base64") });
  });

  it("text → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 'hello'::text AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("hello");
  });

  it("varchar → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT 'world'::varchar(16) AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("world");
  });

  it("uuid → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery(
      "SELECT '550e8400-e29b-41d4-a716-446655440000'::uuid AS x",
    );
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("550e8400-e29b-41d4-a716-446655440000");
  });

  it("json → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery(`SELECT '{"a":1}'::json AS x`);
    expect(status).toBe(200);
    expect(firstCell(body)).toBe('{"a":1}');
  });

  it("jsonb → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery(`SELECT '{"b":2}'::jsonb AS x`);
    expect(status).toBe(200);
    // jsonb may normalize whitespace; the decoder is the identity over text
    // so we just check that we got a parseable JSON string back.
    const cell = firstCell(body);
    expect(typeof cell).toBe("string");
    expect(JSON.parse(cell as string)).toEqual({ b: 2 });
  });

  it("timestamp → ISO 8601 (space replaced with T)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT '2025-01-15 14:30:45'::timestamp AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("2025-01-15T14:30:45");
  });

  it("timestamptz → ISO 8601 with explicit minutes on the tz offset", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT '2025-01-15 14:30:45+00'::timestamptz AS x");
    expect(status).toBe(200);
    // Postgres normalizes timestamptz to the session timezone (UTC here).
    expect(firstCell(body)).toBe("2025-01-15T14:30:45+00:00");
  });

  it("date → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT '2025-01-15'::date AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("2025-01-15");
  });

  it("time → Text(string)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT '14:30:45'::time AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("14:30:45");
  });

  it("NULL → null", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELECT NULL::text AS x");
    expect(status).toBe(200);
    expect(firstCell(body)).toBeNull();
  });

  // ---- end-to-end checks beyond the type table ----------------------

  it("listTables returns user-schema tables (excludes pg_catalog / information_schema)", async (ctx) => {
    if (skipReason || !app || !connectionId) return ctx.skip();
    // Create a fixture table via the same HTTP path so we exercise the
    // full stack rather than poking pg directly.
    const create = await request(app.getHttpServer())
      .post(`/connections/${connectionId}/query`)
      .set("Content-Type", "application/json")
      .send({ sql: "CREATE TABLE IF NOT EXISTS integ_fixture (id int primary key)" });
    expect(create.status).toBe(200);

    // The current contract surface only exposes /tables for the legacy
    // global adapter; per-connection listTables is reachable through the
    // adapter directly. We assert via SELECT against pg_catalog instead,
    // which uses the same SQL the adapter uses internally.
    const { status, body } = await runQuery(
      "SELECT tablename FROM pg_catalog.pg_tables WHERE schemaname = 'public' AND tablename = 'integ_fixture'",
    );
    expect(status).toBe(200);
    expect(firstCell(body)).toBe("integ_fixture");
  });

  it("syntax error surfaces as 400 query envelope (not 500)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery("SELEC 1");
    expect(status).toBe(400);
    expect((body as { error: { category: string } }).error.category).toBe("query");
  });

  // ---- ticket 0024: wire format and server-side timeout --------------

  // The stub-level guard proves we reject binary; this proves the server
  // is not sending it in the first place. Worth a live assertion because
  // the failure it protects against is silent: a binary int4 of 1 is
  // `00 00 00 01`, valid UTF-8, rendering as four invisible control
  // characters (desktop ADR-0070, shipped broken in desktop v0.4.0). The
  // three types below are the ones desktop names — a small int, a wide
  // int, and a fixed-width non-numeric.
  it("row-producing paths come back in text format, not binary (ADR-0070)", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { status, body } = await runQuery(
      "SELECT 1::int4 AS a, 9223372036854775807::int8 AS b, " +
        "'0b3ff9a4-2f6e-4d1b-9f2a-1c4f7e8d5a60'::uuid AS c",
    );
    // A binary reply would now surface as 400 from the guard rather than
    // as mojibake in the cells, so the status assertion carries weight.
    expect(status).toBe(200);
    const row = (body as { rows: unknown[][] }).rows[0];
    expect(row?.[0]).toBe(1);
    expect(row?.[1]).toBe("9223372036854775807");
    expect(row?.[2]).toBe("0b3ff9a4-2f6e-4d1b-9f2a-1c4f7e8d5a60");
  });

  // The distinction this test exists for: pg's `query_timeout` alone
  // makes the *client* stop waiting while the statement keeps running on
  // the server. Asserting "the call rejected" would pass either way. So
  // assert the server's own abort — SQLSTATE 57014,
  // `query_canceled` — which only `statement_timeout` produces.
  it("an over-budget statement is aborted by the server, SQLSTATE 57014 (ADR-0081)", async (ctx) => {
    if (skipReason || !container) return ctx.skip();
    const host = container.getHost();
    const port = container.getMappedPort(5432);
    // A dedicated adapter with a short budget. The registered connection
    // carries the 30 s default, which is not a practical test duration.
    const adapter = createPostgresAdapter({
      connectionString: `postgresql://test:test@${host}:${port}/test?sslmode=disable`,
      statementTimeoutMs: 300,
    });
    try {
      await expect(adapter.executeQuery("SELECT pg_sleep(5)")).rejects.toThrow(
        /statement timeout|canceling statement/i,
      );
    } finally {
      await adapter.close();
    }
  }, 30_000);

  // ---- ticket 0027: TLS is required unless refused --------------------

  // Every other test in this file opts out of TLS explicitly, and a suite
  // that only ever passes `sslmode=disable` cannot tell a hardened default
  // from a default that was never applied. This is the one test that omits
  // the parameter, so it is the only evidence that the opt-out is doing
  // anything. `postgres:16-alpine` has no TLS configured, so requiring it
  // must fail to connect — a plaintext success here would mean the
  // hardening in `resolvePostgresPoolOptions` had silently stopped
  // working, which is exactly the failure ADR-0078 is about.
  it("refuses to connect in plaintext when TLS was not opted out (ADR-0078)", async (ctx) => {
    if (skipReason || !container) return ctx.skip();
    const host = container.getHost();
    const port = container.getMappedPort(5432);
    const adapter = createPostgresAdapter({
      connectionString: `postgresql://test:test@${host}:${port}/test`,
    });
    try {
      await expect(adapter.executeQuery("SELECT 1")).rejects.toThrow(/does not support SSL/i);
    } finally {
      await adapter.close();
    }
  }, 30_000);

  // Slice B's field, end to end and over HTTP. The DTO tests prove it
  // validates and the resolver tests prove it wins over the URL, but
  // neither shows it survives the trip through the controller, the use
  // case and the factory into `pg.Pool`. Registering over HTTP and then
  // running a query is the only evidence that nothing in that chain drops
  // it — and the split-fields path is the one that needs it, because it
  // composes no URL and so has nowhere else to say `disable`.
  it("honours sslMode as a field on the split-fields path (0027 slice B)", async (ctx) => {
    if (skipReason || !container || !app) return ctx.skip();
    const reg = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({
        label: "tc-pg-parts",
        driver: "postgres",
        host: container.getHost(),
        port: container.getMappedPort(5432),
        database: "test",
        user: "test",
        password: "test",
        sslMode: "disable",
      });
    expect(reg.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post(`/connections/${reg.body.id}/query`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1 AS one" });
    expect(res.status).toBe(200);
  }, 30_000);

  // The same registration without the field must fail, for the same
  // reason the URL case above fails. Without this, the test above would
  // still pass if `sslMode` were being dropped somewhere in the chain and
  // the split path had simply never been hardened.
  it("requires TLS on the split-fields path when sslMode is omitted", async (ctx) => {
    if (skipReason || !container || !app) return ctx.skip();
    const reg = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({
        label: "tc-pg-parts-tls",
        driver: "postgres",
        host: container.getHost(),
        port: container.getMappedPort(5432),
        database: "test",
        user: "test",
        password: "test",
      });
    expect(reg.status).toBe(201);

    const res = await request(app.getHttpServer())
      .post(`/connections/${reg.body.id}/query`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1 AS one" });
    expect(res.status).not.toBe(200);
  }, 30_000);

  // ---- ticket 0026: describeTable against a real catalog -------------

  // Stubs can prove the assembly logic; only a live catalog can prove the
  // query shape. Three things here are invisible to a stub: the
  // information_schema domain types decode as strings because of the
  // ::TEXT casts, `ordinal_position` arrives as a string under the
  // identity type parser, and binding $1/$2 does not flip the result wire
  // format to binary (which would trip the ADR-0070 guard).
  describe("describeTable (ADR-0028)", () => {
    async function withAdapter<T>(fn: (a: ReturnType<typeof createPostgresAdapter>) => Promise<T>) {
      const host = container?.getHost();
      const port = container?.getMappedPort(5432);
      const adapter = createPostgresAdapter({
        connectionString: `postgresql://test:test@${host}:${port}/test?sslmode=disable`,
      });
      try {
        return await fn(adapter);
      } finally {
        await adapter.close();
      }
    }

    it("reports nullability, defaults and a composite key in key order", async (ctx) => {
      if (skipReason) return ctx.skip();
      const setup = await runQuery(
        "CREATE TABLE IF NOT EXISTS describe_fixture (" +
          "  b int NOT NULL," +
          "  a text NOT NULL," +
          "  note varchar(20) DEFAULT 'hi'," +
          "  PRIMARY KEY (a, b))",
      );
      expect(setup.status).toBe(200);

      const schema = await withAdapter((a) =>
        a.describeTable({ schema: "public", name: "describe_fixture" }),
      );

      expect(schema.table).toEqual({ schema: "public", name: "describe_fixture" });
      // Declaration order, not key order — `b` is declared first.
      expect(schema.columns.map((c) => [c.name, c.ordinal])).toEqual([
        ["b", 1],
        ["a", 2],
        ["note", 3],
      ]);
      // Key order, which differs from declaration order here. That is the
      // whole reason `primary_key` is a list and not a derived filter.
      expect(schema.primary_key).toEqual(["a", "b"]);
      expect(schema.columns.map((c) => c.primary_key)).toEqual([true, true, false]);
      expect(schema.columns.map((c) => c.nullable)).toEqual([false, false, true]);
      expect(schema.columns.map((c) => c.declared_type)).toEqual([
        "integer",
        "text",
        "character varying",
      ]);
      // Raw DDL text, unparsed.
      expect(schema.columns[2]?.default_value).toBe("'hi'::character varying");
    });

    it("reports an empty primary_key for a keyless table", async (ctx) => {
      if (skipReason) return ctx.skip();
      const setup = await runQuery("CREATE TABLE IF NOT EXISTS describe_keyless (x int)");
      expect(setup.status).toBe(200);

      const schema = await withAdapter((a) =>
        a.describeTable({ schema: null, name: "describe_keyless" }),
      );
      expect(schema.primary_key).toEqual([]);
      expect(schema.columns[0]?.primary_key).toBe(false);
    });

    // A quoted identifier keeps its case in the catalog, so the bound
    // value must match exactly — an interpolated, lower-cased, or
    // unquoted lookup would silently miss.
    it("matches a case-sensitive identifier and one containing a quote", async (ctx) => {
      if (skipReason) return ctx.skip();
      const setup = await runQuery('CREATE TABLE IF NOT EXISTS "Mixed""Case" (id int)');
      expect(setup.status).toBe(200);

      const schema = await withAdapter((a) =>
        a.describeTable({ schema: null, name: 'Mixed"Case' }),
      );
      expect(schema.columns.map((c) => c.name)).toEqual(["id"]);
    });

    // The two routes together: the flag says the depth is available, the
    // describe route delivers it. Neither is worth much without the other.
    it("is advertised and reachable over HTTP for a registered connection", async (ctx) => {
      if (skipReason || !app || !connectionId) return ctx.skip();
      const setup = await runQuery(
        "CREATE TABLE IF NOT EXISTS describe_http (id serial PRIMARY KEY, label text)",
      );
      expect(setup.status).toBe(200);

      const caps = await request(app.getHttpServer()).get(
        `/connections/${connectionId}/capabilities`,
      );
      expect(caps.status).toBe(200);
      expect(caps.body).toMatchObject({
        id: "postgres",
        capabilities: { has_describe_table: true },
      });

      const res = await request(app.getHttpServer())
        .get(`/connections/${connectionId}/table-schema`)
        .query({ table: "describe_http" });
      expect(res.status).toBe(200);
      expect(res.body.primary_key).toEqual(["id"]);
      expect(res.body.columns).toEqual([
        {
          name: "id",
          declared_type: "integer",
          nullable: false,
          primary_key: true,
          ordinal: 1,
          default_value: "nextval('describe_http_id_seq'::regclass)",
        },
        {
          name: "label",
          declared_type: "text",
          nullable: true,
          primary_key: false,
          ordinal: 2,
          default_value: null,
        },
      ]);
    });

    it("reports an unknown table over HTTP as a 400 query envelope", async (ctx) => {
      if (skipReason || !app || !connectionId) return ctx.skip();
      const res = await request(app.getHttpServer())
        .get(`/connections/${connectionId}/table-schema`)
        .query({ table: "no_such_table" });
      // A missing table is the client naming something that is not there —
      // a query-level failure, not a capability the server lacks.
      expect(res.status).toBe(400);
      expect(res.body.error.category).toBe("query");
    });

    it("rejects an unknown table as a missing relation", async (ctx) => {
      if (skipReason) return ctx.skip();
      await expect(
        withAdapter((a) => a.describeTable({ schema: "public", name: "no_such_table" })),
      ).rejects.toThrow(/relation "public\.no_such_table" does not exist/);
    });
  });
});
