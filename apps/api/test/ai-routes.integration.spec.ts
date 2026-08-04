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
  type AiResponse,
} from "../src/domain/ai/ai-provider.port";
import type { HistoryRecord } from "../src/domain/history-record";
import { ContractErrorFilter } from "../src/presentation/filters/contract-error.filter";
import { RequestLevelRejectionFilter } from "../src/presentation/filters/request-level-rejection.filter";
import { createBearerAuthMiddleware } from "../src/presentation/middleware/bearer-auth.middleware";

// 0020 — POST /ai/explain + POST /ai/suggest integration. Asserts the
// wire envelope, the env-var-gate disabled mode, the upstream-failure
// mapping, the bearer-auth gate, and how AI calls appear in
// /history/export.jsonl.
//
// That last one used to assert the export stayed *empty*: recording an
// AI call would have forced a v:1 → v:2 schema bump ahead of cross-repo
// coordination. Ticket 0023 is that coordination — desktop ADR-0027
// defines `kind: "ai"` — so the canary is inverted rather than deleted.
// It now guards the opposite failure: AI calls silently going unlogged.

const SECRET = "integration-secret-32-chars-long!";

type StubResponse = Pick<AiResponse, "text" | "model"> & Partial<AiResponse>;

interface ProviderOverrides {
  explain?: (req: { sql: string; dialect?: string }) => Promise<StubResponse>;
  suggestSql?: (req: { prompt: string; dialect?: string }) => Promise<StubResponse>;
}

// Fills in the fields history v:2 needs but a test rarely cares about, so
// individual cases can keep writing `{ text, model }`.
function complete(response: StubResponse): AiResponse {
  return { tokensIn: null, tokensOut: null, stopReason: null, ...response };
}

function stubProvider(overrides: ProviderOverrides = {}): AiProvider {
  const explain = overrides.explain;
  const suggestSql = overrides.suggestSql;
  return {
    getId: () => "stub",
    getModel: () => "stub-model",
    getCapabilities: () => NO_AI_CAPABILITIES,
    explain: async (req) =>
      complete(
        explain === undefined
          ? { text: "default explanation", model: "stub-model" }
          : await explain(req),
      ),
    suggestSql: async (req) =>
      complete(
        suggestSql === undefined
          ? { text: "SELECT 1;", model: "stub-model" }
          : await suggestSql(req),
      ),
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

  describe("history v:2 recording (ticket 0023)", () => {
    async function exportedRecords(): Promise<HistoryRecord[]> {
      const res = await request(app.getHttpServer())
        .get("/history/export.jsonl")
        .set("Authorization", `Bearer ${SECRET}`);
      expect(res.status).toBe(200);
      return res.text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as HistoryRecord);
    }

    it("records both AI routes as kind:'ai' v:2 records", async () => {
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
        .send({ prompt: "recent orders" });
      expect(suggestRes.status).toBe(200);

      const records = await exportedRecords();
      expect(records).toHaveLength(2);
      expect(records.map((r) => [r.v, r.kind])).toStrictEqual([
        [2, "ai"],
        [2, "ai"],
      ]);
      expect(records[0]).toMatchObject({
        intent: "explain",
        prompt: "SELECT 1",
        response: "default explanation",
        status: "ok",
        provider: "stub",
        model: "stub-model",
        // No connection is bound to an AI route, and web still has no
        // authenticated actor.
        conn: null,
        actor: null,
        error: null,
      });
      expect(records[1]).toMatchObject({
        intent: "suggest_sql",
        prompt: "recent orders",
        response: "SELECT 1;",
        status: "ok",
      });
    });

    it("records an upstream failure as status:'error' with the AI category", async () => {
      const explain = vi.fn().mockRejectedValue(new AiError("upstream 503"));
      app = await buildAppWith(stubProvider({ explain }));

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1" });
      expect(res.status).toBe(502);

      const records = await exportedRecords();
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        v: 2,
        kind: "ai",
        status: "error",
        // The wire category is `ai_provider` (502); the recorded one is
        // the narrower history taxonomy. They are deliberately distinct
        // vocabularies — see history-record.ts.
        error: { category: "provider", message: "upstream 503" },
      });
    });

    it("records nothing when the deployment has no provider", async () => {
      app = await buildAppWith(undefined);

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1" });
      expect(res.status).toBe(404);

      // There was no AI call to record: no provider was reached, so the
      // record would have to invent the `provider` and `model` the
      // schema requires.
      expect(await exportedRecords()).toStrictEqual([]);
    });
  });
});
