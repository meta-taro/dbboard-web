import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpStatus, ValidationPipe } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { contentTypeGuard } from "../src/bootstrap/content-type.middleware";
import { AiError } from "../src/domain/ai/ai-error";
import {
  AI_PROVIDER,
  NO_AI_CAPABILITIES,
  type AiProvider,
} from "../src/domain/ai/ai-provider.port";
import { ContractErrorFilter } from "../src/presentation/filters/contract-error.filter";
import { RequestLevelRejectionFilter } from "../src/presentation/filters/request-level-rejection.filter";
import { createBearerAuthMiddleware } from "../src/presentation/middleware/bearer-auth.middleware";

// 0020 — POST /ai/explain + POST /ai/suggest integration. Asserts the
// wire envelope, the env-var-gate disabled mode, the upstream-failure
// mapping, the bearer-auth gate, and — most importantly — that an AI
// call leaves /history/export.jsonl empty (hard redline from Slice 1).

const SECRET = "integration-secret-32-chars-long!";

interface ProviderOverrides {
  explain?: (req: { sql: string; dialect?: string }) => Promise<{ text: string; model: string }>;
  suggestSql?: (req: {
    prompt: string;
    dialect?: string;
  }) => Promise<{ text: string; model: string }>;
}

function stubProvider(overrides: ProviderOverrides = {}): AiProvider {
  return {
    getId: () => "stub",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain:
      overrides.explain ?? (async () => ({ text: "default explanation", model: "stub-model" })),
    suggestSql: overrides.suggestSql ?? (async () => ({ text: "SELECT 1;", model: "stub-model" })),
  };
}

// Mirror of createApp() from src/main.ts, but composed against a
// pre-built TestingModule so the integration suite can override
// AI_PROVIDER per-test without juggling process.env. Re-uses the same
// global middleware / pipes / filters so the wire surface matches
// production behaviour byte-for-byte.
async function buildAppWith(provider: AiProvider | undefined): Promise<NestExpressApplication> {
  process.env.DBBOARD_API_SECRET = SECRET;
  const builder = Test.createTestingModule({ imports: [AppModule] });
  builder.overrideProvider(AI_PROVIDER).useValue(provider);
  const moduleRef = await builder.compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({ bodyParser: false });
  app.use(contentTypeGuard);
  app.use(createBearerAuthMiddleware(SECRET));
  // Match createApp(): same body parser, same pipes, same LIFO filter order.
  app.useBodyParser("json", { limit: 65_536 });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
    }),
  );
  app.useGlobalFilters(new RequestLevelRejectionFilter(), new ContractErrorFilter());
  await app.init();
  return app;
}

describe("AI HTTP routes (0020)", () => {
  let app: NestExpressApplication;
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  afterEach(async () => {
    await app?.close();
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  describe("POST /ai/explain", () => {
    it("returns 200 + { text, model } when the provider succeeds", async () => {
      const explain = vi.fn().mockResolvedValue({ text: "scans users", model: "claude-x" });
      app = await buildAppWith(stubProvider({ explain }));

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT * FROM users", dialect: "postgres" });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ text: "scans users", model: "claude-x" });
      expect(explain).toHaveBeenCalledExactlyOnceWith({
        sql: "SELECT * FROM users",
        dialect: "postgres",
      });
    });

    it("returns 404 + ai_disabled envelope when no provider is configured", async () => {
      app = await buildAppWith(undefined);

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1" });

      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual({
        error: { category: "ai_disabled", message: "AI provider is not configured" },
      });
    });

    it("returns 502 + ai_provider envelope when the provider throws AiError", async () => {
      const explain = vi.fn().mockRejectedValue(new AiError("upstream 503"));
      app = await buildAppWith(stubProvider({ explain }));

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1" });

      expect(res.status).toBe(502);
      expect(res.body).toStrictEqual({
        error: { category: "ai_provider", message: "upstream 503" },
      });
    });

    it("returns 422 when sql is missing (ValidationPipe → semantic failure)", async () => {
      app = await buildAppWith(stubProvider());

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({});

      expect(res.status).toBe(422);
    });

    it("returns 415 when the request omits application/json (content-type guard)", async () => {
      app = await buildAppWith(stubProvider());

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "text/plain")
        .send("SELECT 1");

      expect(res.status).toBe(415);
    });

    it("returns 401 when the bearer header is missing", async () => {
      app = await buildAppWith(stubProvider());

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1" });

      expect(res.status).toBe(401);
    });
  });

  describe("POST /ai/suggest", () => {
    it("returns 200 + { text, model } when the provider succeeds", async () => {
      const suggestSql = vi
        .fn()
        .mockResolvedValue({ text: "SELECT * FROM orders;", model: "claude-x" });
      app = await buildAppWith(stubProvider({ suggestSql }));

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ prompt: "recent orders", dialect: "sqlite" });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ text: "SELECT * FROM orders;", model: "claude-x" });
      expect(suggestSql).toHaveBeenCalledExactlyOnceWith({
        prompt: "recent orders",
        dialect: "sqlite",
      });
    });

    it("returns 404 + ai_disabled envelope when no provider is configured", async () => {
      app = await buildAppWith(undefined);

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ prompt: "users" });

      expect(res.status).toBe(404);
      expect(res.body.error.category).toBe("ai_disabled");
    });

    it("returns 422 when prompt is missing", async () => {
      app = await buildAppWith(stubProvider());

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({});

      expect(res.status).toBe(422);
    });
  });

  // The hard redline. AI calls must never enter history.jsonl —
  // recording would force a v:1 → v:2 schema bump ahead of cross-repo
  // coordination and break the 0018 round-trip cross-check. This test
  // is the canary: if a future change wraps AiController in
  // HistoryRecordingInterceptor, /history/export.jsonl will fail to
  // stay empty and this test will go red.
  it("does not record AI calls in /history/export.jsonl", async () => {
    app = await buildAppWith(stubProvider());

    const explainRes = await request(app.getHttpServer())
      .post("/ai/explain")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });
    expect(explainRes.status).toBe(200);

    const suggestRes = await request(app.getHttpServer())
      .post("/ai/suggest")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ prompt: "x" });
    expect(suggestRes.status).toBe(200);

    const historyRes = await request(app.getHttpServer())
      .get("/history/export.jsonl")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(historyRes.status).toBe(200);
    expect(historyRes.text).toBe("");
  });
});
