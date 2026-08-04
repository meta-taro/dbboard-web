import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
