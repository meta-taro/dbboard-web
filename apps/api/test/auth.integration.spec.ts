import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../src/main";

const SECRET = "integration-secret-32-chars-long!";

describe("HTTP bearer-auth integration (0016)", () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createApp({ apiSecret: SECRET });
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it("GET /health passes without an Authorization header (liveness exemption)", async () => {
    const res = await request(app.getHttpServer()).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("GET /connections returns 401 without the bearer header", async () => {
    const res = await request(app.getHttpServer()).get("/connections");
    expect(res.status).toBe(401);
  });

  it("GET /connections returns 200 with the correct bearer header", async () => {
    const res = await request(app.getHttpServer())
      .get("/connections")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ connections: [] });
  });

  it("POST /connections returns 401 without the bearer header (SSRF surface)", async () => {
    const res = await request(app.getHttpServer())
      .post("/connections")
      .set("Content-Type", "application/json")
      .send({ label: "x", driver: "postgres", connectionString: "postgres://x:y@h/d" });
    expect(res.status).toBe(401);
  });

  it("GET /history/export.jsonl returns 401 without the bearer header (NDJSON egress)", async () => {
    const res = await request(app.getHttpServer()).get("/history/export.jsonl");
    expect(res.status).toBe(401);
  });

  it("GET /tables returns 401 without the bearer header", async () => {
    const res = await request(app.getHttpServer()).get("/tables");
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token with 401", async () => {
    const res = await request(app.getHttpServer())
      .get("/connections")
      .set("Authorization", "Bearer wrong-token-of-different-length");
    expect(res.status).toBe(401);
  });
});
