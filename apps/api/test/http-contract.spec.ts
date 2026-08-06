import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RESTORE_BODY_LIMIT_BYTES } from "../src/domain/limits";
import { createApp } from "../src/main";

describe("HTTP contract surface (0003)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  // ---- Contract-mirror endpoints --------------------------------------

  it("GET /health → { status: 'ok' }", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /tables → empty list behind the NullAdapter", async () => {
    const res = await request(app.getHttpServer()).get("/tables");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tables: [] });
  });

  it("GET /capabilities → { id: 'null', capabilities: <all false> }", async () => {
    const res = await request(app.getHttpServer()).get("/capabilities");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: "null",
      capabilities: {
        has_views: false,
        has_functions: false,
        has_auth: false,
        has_storage: false,
        has_realtime: false,
        has_describe_table: false,
        has_table_ddl: false,
        has_execute: false,
        has_atomic_restore: false,
      },
    });
  });

  // ---- POST /query --------------------------------------------------

  it("POST /query against the NullAdapter → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { category: "capability", message: expect.stringContaining("null adapter") },
    });
  });

  // ---- Request-level rejections (contract § "Request-level rejections")

  it("POST /query with text/plain → 415 plain text", async () => {
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "text/plain")
      .send("SELECT 1");
    expect(res.status).toBe(415);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    // No JSON envelope on request-level rejections (docs/api-contract.md
    // § Request-level rejections).
    expect(res.body).toEqual({});
  });

  it("POST /query with malformed JSON → 400 plain text", async () => {
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "application/json")
      .send("{not json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toEqual({});
  });

  it("POST /query missing sql → 422", async () => {
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "application/json")
      .send({});
    expect(res.status).toBe(422);
  });

  it("POST /query with non-string sql → 422", async () => {
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "application/json")
      .send({ sql: 12 });
    expect(res.status).toBe(422);
  });

  it("POST /query with empty sql → 422", async () => {
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "application/json")
      .send({ sql: "" });
    expect(res.status).toBe(422);
  });

  it("POST /query body over the seam → 413 plain text", async () => {
    // The contract pins the limit at 64 KiB. Build a payload above it to
    // confirm the cap rejects rather than reaches the handler, and that
    // the body comes back as plain text (no JSON envelope).
    const big = "x".repeat(70 * 1024);
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "application/json")
      .send({ sql: big });
    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
    expect(res.body).toEqual({});
  });

  // ---- /connections surface ----------------------------------------

  it("POST /connections then GET /connections returns the registered view (no adapter/secrets)", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Integration", driver: "null" });
    expect(create.status).toBe(201);
    expect(create.body.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    const list = await request(app.getHttpServer()).get("/connections");
    expect(list.status).toBe(200);
    const view = list.body.connections.find((c: { id: string }) => c.id === create.body.id);
    expect(view).toEqual({ id: create.body.id, label: "Integration", driver: "null" });
    expect(view).not.toHaveProperty("adapter");
  });

  it("POST /connections with an unknown driver → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Mongo prod", driver: "mongo" });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { category: "capability", message: expect.stringContaining("unknown driver") },
    });
  });

  it("POST /connections with driver=postgres but no connection info → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Postgres prod", driver: "postgres" });
    expect(res.status).toBe(404);
    expect(res.body.error.category).toBe("capability");
    expect(res.body.error.message).toMatch(/connectionString|host/);
  });

  // The DTO spec proves the validator rejects it; this proves the
  // rejection reaches the client as a refusal rather than being whitelisted
  // away into a silent plaintext connection. `whitelist: true` drops
  // undeclared fields, so an unrecognised TLS spelling would be dropped —
  // the field has to be declared *and* constrained for this to be a 422.
  it("POST /connections with a TLS mode it cannot honour → 422", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({
        label: "Prefer",
        driver: "postgres",
        host: "db.example.com",
        sslMode: "prefer",
      });
    expect(res.status).toBe(422);
  });

  it("POST /connections/:id/query routes to the registered adapter", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Scoped null", driver: "null" });
    const res = await request(app.getHttpServer())
      .post(`/connections/${create.body.id}/query`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });
    // NullAdapter still throws capability, but the route was reached.
    expect(res.status).toBe(404);
    expect(res.body.error.category).toBe("capability");
  });

  it("POST /connections/:id/query with an unknown id → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections/does-not-exist/query")
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      category: "capability",
      message: expect.stringContaining("unknown connection"),
    });
  });

  // ---- /connections/:id/tables surface (0017) ----------------------

  it("GET /connections/:id/tables returns the contract shape behind the NullAdapter", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Scoped tables", driver: "null" });
    const res = await request(app.getHttpServer()).get(`/connections/${create.body.id}/tables`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ tables: [] });
  });

  it("GET /connections/:id/tables with an unknown id → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer()).get("/connections/does-not-exist/tables");
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      category: "capability",
      message: expect.stringContaining("unknown connection"),
    });
  });

  // ---- /connections/:id/capabilities surface (0026) ------------------

  it("GET /connections/:id/capabilities answers for that connection's adapter", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Scoped caps", driver: "null" });
    const res = await request(app.getHttpServer()).get(
      `/connections/${create.body.id}/capabilities`,
    );
    expect(res.status).toBe(200);
    // Same shape as GET /capabilities so one client type covers both.
    expect(res.body.id).toBe("null");
    expect(res.body.capabilities.has_describe_table).toBe(false);
  });

  it("GET /connections/:id/capabilities with an unknown id → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer()).get("/connections/does-not-exist/capabilities");
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      category: "capability",
      message: expect.stringContaining("unknown connection"),
    });
  });

  // ---- /connections/:id/table-schema surface (0026) ------------------

  it("GET /connections/:id/table-schema → 404 when the adapter cannot describe", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Scoped describe", driver: "null" });
    const res = await request(app.getHttpServer())
      .get(`/connections/${create.body.id}/table-schema`)
      .query({ table: "users" });
    expect(res.status).toBe(404);
    expect(res.body.error.category).toBe("capability");
    expect(res.body.error.message).toMatch(/describe/i);
  });

  it("GET /connections/:id/table-schema with an unknown id → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer())
      .get("/connections/does-not-exist/table-schema")
      .query({ table: "users" });
    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      category: "capability",
      message: expect.stringContaining("unknown connection"),
    });
  });

  it("GET /connections/:id/table-schema without ?table → 422", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Missing table param", driver: "null" });
    const res = await request(app.getHttpServer()).get(
      `/connections/${create.body.id}/table-schema`,
    );
    expect(res.status).toBe(422);
  });

  // ---- Secret-leak guard (0004 § Tasks) ----------------------------

  it("GET /connections never echoes the registered password or connectionString", async () => {
    // Sentinel values chosen so a substring scan over the JSON response
    // catches any leak path — record fields, error messages, anything.
    const PW = "PW-SENTINEL-9f3c";
    const URL_SENTINEL = "URL-SENTINEL-1a2b";
    await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({
        label: "Leak guard",
        driver: "postgres",
        connectionString: `postgresql://u:${URL_SENTINEL}@127.0.0.1:1/db?app=${URL_SENTINEL}`,
      });
    await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({
        label: "Leak guard 2",
        driver: "postgres",
        host: "127.0.0.1",
        port: 5432,
        database: "db",
        user: "u",
        password: PW,
      });
    const list = await request(app.getHttpServer()).get("/connections");
    expect(list.status).toBe(200);
    const dumped = JSON.stringify(list.body);
    expect(dumped).not.toContain(PW);
    expect(dumped).not.toContain(URL_SENTINEL);

    // 0027 slice F, on the same two fixtures rather than in a test of their
    // own: "no password" and "the parts come back" are one property, and
    // asserting them apart is how a response that satisfies neither ends up
    // passing the half that was checked. The URL fixture is the interesting
    // one — its host, port, database and user were recovered from a DSN whose
    // password is one of the sentinels above.
    const listed = list.body.connections as Array<{
      label: string;
      parts?: Record<string, unknown>;
    }>;
    expect(listed.find((c) => c.label === "Leak guard")?.parts).toEqual({
      host: "127.0.0.1",
      port: 1,
      database: "db",
      user: "u",
    });
    expect(listed.find((c) => c.label === "Leak guard 2")?.parts).toEqual({
      host: "127.0.0.1",
      port: 5432,
      database: "db",
      user: "u",
    });
    // The query parameter the URL fixture carries is dropped with the rest of
    // the DSN. Only the five named parts survive, so a provider URL that
    // encodes something private in a parameter cannot ride along.
    expect(dumped).not.toContain("app=");
  });

  // ---- Editing a registered connection (0027 slice G) ---------------

  it("PATCH /connections/:id renames without re-pointing the connection", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({
        label: "Before",
        driver: "postgres",
        host: "127.0.0.1",
        port: 5432,
        database: "app",
        user: "reader",
        password: "PW-RENAME-4d71",
      });

    const res = await request(app.getHttpServer())
      .patch(`/connections/${create.body.id}`)
      .set("Content-Type", "application/json")
      .send({ label: "After" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: create.body.id,
      label: "After",
      driver: "postgres",
      parts: { host: "127.0.0.1", port: 5432, database: "app", user: "reader" },
    });
  });

  it("PATCH /connections/:id re-points the connection and echoes no credential", async () => {
    // The blank password is the case worth having at this level: it is what
    // an edit form submits for the box nobody typed in, and the whole of
    // ADR-0080 is that it must reach the server and mean "keep". That the
    // credential really is kept is pinned one layer down, in
    // `carryCredential` and `PostgresAdapter.rebuildWith` — from out here
    // there is deliberately nothing that reports a password. What this test
    // proves is the other half: the round trip does not reject the blank
    // box, and nothing leaks on the way back.
    const PW = "PW-EDIT-SENTINEL-8b2e";
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({
        label: "Editable",
        driver: "postgres",
        host: "old.host",
        port: 5432,
        database: "app",
        user: "reader",
        password: PW,
      });

    const res = await request(app.getHttpServer())
      .patch(`/connections/${create.body.id}`)
      .set("Content-Type", "application/json")
      .send({
        host: "new.host",
        port: 6543,
        database: "app",
        user: "writer",
        password: "",
        sslMode: "require",
      });

    expect(res.status).toBe(200);
    expect(res.body.parts).toEqual({
      host: "new.host",
      port: 6543,
      database: "app",
      user: "writer",
      sslMode: "require",
    });

    const list = await request(app.getHttpServer()).get("/connections");
    const listed = (list.body.connections as Array<{ id: string; parts?: unknown }>).find(
      (c) => c.id === create.body.id,
    );
    expect(listed?.parts).toEqual(res.body.parts);
    expect(JSON.stringify(res.body)).not.toContain(PW);
    expect(JSON.stringify(list.body)).not.toContain(PW);
  });

  it("PATCH /connections/:id cannot change the driver", async () => {
    // Dropped by the same whitelist pipe that drops any undeclared field.
    // Silently, on purpose: the field never reaches the use case, so there
    // is no way for an edit to keep an id and a label while changing what
    // the connection is.
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Fixed driver", driver: "null" });

    const res = await request(app.getHttpServer())
      .patch(`/connections/${create.body.id}`)
      .set("Content-Type", "application/json")
      .send({ label: "Still null", driver: "postgres" });

    expect(res.status).toBe(200);
    expect(res.body.driver).toBe("null");
  });

  it("PATCH /connections/:id with an unknown id → 404 capability envelope", async () => {
    const res = await request(app.getHttpServer())
      .patch("/connections/never-existed")
      .set("Content-Type", "application/json")
      .send({ label: "Ghost" });

    expect(res.status).toBe(404);
    expect(res.body.error).toEqual({
      category: "capability",
      message: expect.stringContaining("unknown connection"),
    });
  });

  it("PATCH /connections/:id with a TLS mode it cannot honour → 422", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "TLS", driver: "null" });

    const res = await request(app.getHttpServer())
      .patch(`/connections/${create.body.id}`)
      .set("Content-Type", "application/json")
      .send({ sslMode: "verify-full" });

    expect(res.status).toBe(422);
  });

  // ---- restore: the one non-JSON body (0030 slice E) -----------------

  it("POST /connections/:id/restore/plan with application/sql reaches the handler", async () => {
    // The guard's exemption is what this asserts: an unknown connection
    // means the request got past 415 and into the use case.
    const res = await request(app.getHttpServer())
      .post("/connections/never-existed/restore/plan")
      .set("Content-Type", "application/sql")
      .send("CREATE TABLE t (id int);");

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: { category: "capability", message: expect.stringContaining("unknown connection") },
    });
  });

  it("POST /connections/:id/restore with application/sql reaches the handler", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections/never-existed/restore")
      .set("Content-Type", "application/sql")
      .send("CREATE TABLE t (id int);");

    expect(res.status).toBe(404);
  });

  it("POST /connections/:id/restore with text/plain → 415 plain text", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections/never-existed/restore")
      .set("Content-Type", "text/plain")
      .send("CREATE TABLE t (id int);");

    expect(res.status).toBe(415);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("POST /query with application/sql → 415 (the exemption is restore-only)", async () => {
    const res = await request(app.getHttpServer())
      .post("/query")
      .set("Content-Type", "application/sql")
      .send("SELECT 1");

    expect(res.status).toBe(415);
  });

  it("POST /connections/:id/restore with an unrecognised on_error → 422", async () => {
    // Reading anything-but-"continue" as "stop" (desktop's leniency over
    // its own IPC) would hide the caller's typo behind a run that quietly
    // used the other policy.
    const res = await request(app.getHttpServer())
      .post("/connections/never-existed/restore?on_error=abort")
      .set("Content-Type", "application/sql")
      .send("SELECT 1;");

    expect(res.status).toBe(422);
  });

  it("POST /connections/:id/restore with an unrecognised confirmed → 422", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections/never-existed/restore?confirmed=1")
      .set("Content-Type", "application/sql")
      .send("SELECT 1;");

    expect(res.status).toBe(422);
  });

  it("POST /connections/:id/restore over the script cap → 413 plain text", async () => {
    // The restore cap is its own, far above the contract's 64 KiB: a dump
    // is not a query. See RESTORE_BODY_LIMIT_BYTES.
    const over = "x".repeat(RESTORE_BODY_LIMIT_BYTES + 1024);
    const res = await request(app.getHttpServer())
      .post("/connections/never-existed/restore")
      .set("Content-Type", "application/sql")
      .send(over);

    expect(res.status).toBe(413);
    expect(res.headers["content-type"]).toMatch(/^text\/plain/);
  });

  it("POST /query stays on the 64 KiB cap the contract pins", async () => {
    // Guards the restore parser against widening the JSON one.
    const big = "x".repeat(70 * 1024);
    const res = await request(app.getHttpServer())
      .post("/connections/never-existed/query")
      .set("Content-Type", "application/json")
      .send({ sql: big });

    expect(res.status).toBe(413);
  });

  it("DELETE /connections/:id → 204; idempotent on a missing id", async () => {
    const create = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "Doomed", driver: "null" });

    const first = await request(app.getHttpServer()).delete(`/connections/${create.body.id}`);
    expect(first.status).toBe(204);

    const second = await request(app.getHttpServer()).delete(`/connections/${create.body.id}`);
    expect(second.status).toBe(204);

    const third = await request(app.getHttpServer()).delete("/connections/never-existed");
    expect(third.status).toBe(204);
  });
});
