import type { NestExpressApplication } from "@nestjs/platform-express";
import { Test } from "@nestjs/testing";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpStatus, ValidationPipe } from "@nestjs/common";
import { AppModule } from "../src/app.module";
import { contentTypeGuard } from "../src/bootstrap/content-type.middleware";
import { AiError } from "../src/domain/ai/ai-error";
import { AI_PROVIDER_REGISTRY } from "../src/domain/ai/ai-provider-registry.port";
import {
  NO_AI_CAPABILITIES,
  type AiProvider,
  type AiResponse,
  type ExplainRequest,
  type SuggestRequest,
} from "../src/domain/ai/ai-provider.port";
import { StaticAiProviderRegistry } from "../src/infrastructure/static-ai-provider-registry";
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

// The port's own request types rather than a hand-written subset: a stub
// that sees less than the provider does cannot assert what reached it,
// which is exactly what the schema passthrough case needs to check.
interface ProviderOverrides {
  explain?: (req: ExplainRequest) => Promise<StubResponse>;
  suggestSql?: (req: SuggestRequest) => Promise<StubResponse>;
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
// pre-built TestingModule so the integration suite can override the
// provider registry per-test without juggling process.env. Re-uses the
// same global middleware / pipes / filters so the wire surface matches
// production behaviour byte-for-byte.
async function buildAppWithRegistry(
  registry: StaticAiProviderRegistry,
): Promise<NestExpressApplication> {
  process.env.DBBOARD_API_SECRET = SECRET;
  const builder = Test.createTestingModule({ imports: [AppModule] });
  builder.overrideProvider(AI_PROVIDER_REGISTRY).useValue(registry);
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

// The pre-slice-B shape: one provider, or none. Kept as a helper because
// most of this suite is about the routes rather than about which
// provider answers, and a one-entry registry is what "configured" meant
// before the registry existed.
function buildAppWith(provider: AiProvider | undefined): Promise<NestExpressApplication> {
  return buildAppWithRegistry(
    provider === undefined
      ? new StaticAiProviderRegistry([], undefined)
      : new StaticAiProviderRegistry(
          [
            {
              id: "stub",
              name: "stub",
              kind: "anthropic",
              model: provider.getModel(),
              provider,
            },
          ],
          "stub",
        ),
  );
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

    it("passes the table list through to the provider (ADR-0028 Decision 8)", async () => {
      const suggestSql = vi.fn().mockResolvedValue({ text: "SELECT 1;", model: "claude-x" });
      app = await buildAppWith(stubProvider({ suggestSql }));

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({
          prompt: "recent orders",
          schema: [{ schema: "public", name: "orders" }],
        });

      expect(res.status).toBe(200);
      expect(suggestSql).toHaveBeenCalledExactlyOnceWith({
        prompt: "recent orders",
        schema: [{ schema: "public", name: "orders" }],
      });
    });

    it("passes the described tables through, absent nullables normalised (ADR-0028 Decision 9)", async () => {
      const suggestSql = vi.fn().mockResolvedValue({ text: "SELECT 1;", model: "claude-x" });
      app = await buildAppWith(stubProvider({ suggestSql }));

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({
          prompt: "recent orders",
          schema: [{ name: "orders" }],
          full_schema: [
            {
              // No `schema` key, and a column with neither a declared
              // type nor a default: three absences the domain spells
              // `null`, so the boundary is where they become one.
              table: { name: "orders" },
              columns: [{ name: "id", nullable: false, primary_key: true, ordinal: 1 }],
              primary_key: ["id"],
            },
          ],
        });

      expect(res.status).toBe(200);
      expect(suggestSql).toHaveBeenCalledExactlyOnceWith({
        prompt: "recent orders",
        schema: [{ schema: null, name: "orders" }],
        full_schema: [
          {
            table: { schema: null, name: "orders" },
            columns: [
              {
                name: "id",
                declared_type: null,
                nullable: false,
                primary_key: true,
                ordinal: 1,
                default_value: null,
              },
            ],
            primary_key: ["id"],
          },
        ],
      });
    });

    it("returns 422 when a described column is malformed", async () => {
      app = await buildAppWith(stubProvider());

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({
          prompt: "x",
          full_schema: [
            {
              table: { name: "orders" },
              columns: [{ name: "id", nullable: "false", primary_key: true, ordinal: 1 }],
              primary_key: [],
            },
          ],
        });

      expect(res.status).toBe(422);
    });

    it("returns 422 when a schema entry is malformed", async () => {
      app = await buildAppWith(stubProvider());

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ prompt: "x", schema: [{ schema: "public" }] });

      expect(res.status).toBe(422);
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

// Ticket 0032 slice B — several configured providers, and a caller that
// may name one. The disabled deployment above is the same deployment
// with an empty registry, which is why these cases live alongside it.
describe("AI provider selection (0032 slice B)", () => {
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

  function twoProviders(overrides: { fast?: ProviderOverrides; deep?: ProviderOverrides } = {}) {
    const fast = stubProvider(overrides.fast);
    const deep = stubProvider(overrides.deep);
    return {
      fast,
      deep,
      registry: new StaticAiProviderRegistry(
        [
          {
            id: "fast",
            name: "Fast",
            kind: "anthropic",
            model: "claude-sonnet-4-6",
            provider: fast,
          },
          { id: "deep", name: "Deep", kind: "anthropic", model: "claude-opus-4-8", provider: deep },
        ],
        "deep",
      ),
    };
  }

  describe("GET /ai/providers", () => {
    it("lists every configured provider and marks the default", async () => {
      app = await buildAppWithRegistry(twoProviders().registry);

      const res = await request(app.getHttpServer())
        .get("/ai/providers")
        .set("Authorization", `Bearer ${SECRET}`);

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({
        providers: [
          {
            id: "fast",
            name: "Fast",
            kind: "anthropic",
            model: "claude-sonnet-4-6",
            default: false,
            streaming: false,
          },
          {
            id: "deep",
            name: "Deep",
            kind: "anthropic",
            model: "claude-opus-4-8",
            default: true,
            streaming: false,
          },
        ],
      });
    });

    it("never puts a key or a client on the wire", async () => {
      app = await buildAppWithRegistry(twoProviders().registry);

      const res = await request(app.getHttpServer())
        .get("/ai/providers")
        .set("Authorization", `Bearer ${SECRET}`);

      // The descriptor is built from the registry, which holds live
      // clients constructed with the operator's keys. Asserting on the
      // serialised text rather than the parsed body is deliberate: a
      // nested field would still be in here.
      expect(res.text).not.toMatch(/apiKey|api_key|sk-/i);
    });

    it("returns 404 + ai_disabled when nothing is configured, so the panel hides", async () => {
      app = await buildAppWithRegistry(new StaticAiProviderRegistry([], undefined));

      const res = await request(app.getHttpServer())
        .get("/ai/providers")
        .set("Authorization", `Bearer ${SECRET}`);

      expect(res.status).toBe(404);
      expect(res.body).toStrictEqual({
        error: { category: "ai_disabled", message: "AI provider is not configured" },
      });
    });

    it("returns 401 without a bearer header — the list is deployment configuration", async () => {
      app = await buildAppWithRegistry(twoProviders().registry);

      const res = await request(app.getHttpServer()).get("/ai/providers");

      expect(res.status).toBe(401);
    });
  });

  describe("naming a provider on a request", () => {
    it("routes POST /ai/explain to the named provider rather than the default", async () => {
      const explainFast = vi.fn().mockResolvedValue({ text: "fast says", model: "claude-fast" });
      const explainDeep = vi.fn().mockResolvedValue({ text: "deep says", model: "claude-deep" });
      const { registry } = twoProviders({
        fast: { explain: explainFast },
        deep: { explain: explainDeep },
      });
      app = await buildAppWithRegistry(registry);

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1", provider: "fast" });

      expect(res.status).toBe(200);
      expect(res.body).toStrictEqual({ text: "fast says", model: "claude-fast" });
      expect(explainDeep).not.toHaveBeenCalled();
      // The id addressed the request; it is not part of it.
      expect(explainFast).toHaveBeenCalledExactlyOnceWith({ sql: "SELECT 1" });
    });

    it("routes POST /ai/suggest to the named provider too", async () => {
      const suggestFast = vi.fn().mockResolvedValue({ text: "SELECT 1;", model: "claude-fast" });
      const suggestDeep = vi.fn().mockResolvedValue({ text: "SELECT 2;", model: "claude-deep" });
      const { registry } = twoProviders({
        fast: { suggestSql: suggestFast },
        deep: { suggestSql: suggestDeep },
      });
      app = await buildAppWithRegistry(registry);

      const res = await request(app.getHttpServer())
        .post("/ai/suggest")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ prompt: "all users", provider: "fast" });

      expect(res.status).toBe(200);
      expect(suggestDeep).not.toHaveBeenCalled();
      expect(suggestFast).toHaveBeenCalledExactlyOnceWith({ prompt: "all users" });
    });

    it("falls to the default when the field is omitted", async () => {
      const explainDeep = vi.fn().mockResolvedValue({ text: "deep says", model: "claude-deep" });
      const { registry } = twoProviders({ deep: { explain: explainDeep } });
      app = await buildAppWithRegistry(registry);

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1" });

      expect(res.status).toBe(200);
      expect(explainDeep).toHaveBeenCalledOnce();
    });

    it("answers 422 + ai_unknown_provider, naming the id, for a provider that is not configured", async () => {
      app = await buildAppWithRegistry(twoProviders().registry);

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1", provider: "gpt-4o" });

      // Not 404: the deployment does have AI, and a selector out of step
      // with the server must not read as "AI is off" and hide the panel.
      expect(res.status).toBe(422);
      expect(res.body.error.category).toBe("ai_unknown_provider");
      expect(res.body.error.message).toContain("gpt-4o");
    });

    it("still answers 404 for a named provider when nothing is configured at all", async () => {
      app = await buildAppWithRegistry(new StaticAiProviderRegistry([], undefined));

      const res = await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1", provider: "fast" });

      expect(res.status).toBe(404);
      expect(res.body.error.category).toBe("ai_disabled");
    });

    it("records the answering provider's served model, not the default's", async () => {
      const explainFast = vi.fn().mockResolvedValue({ text: "fast says", model: "claude-fast" });
      const { registry } = twoProviders({ fast: { explain: explainFast } });
      app = await buildAppWithRegistry(registry);

      await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1", provider: "fast" });

      const res = await request(app.getHttpServer())
        .get("/history/export.jsonl")
        .set("Authorization", `Bearer ${SECRET}`);
      const records = res.text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as HistoryRecord);

      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ kind: "ai", model: "claude-fast" });
    });

    it("records nothing for an unknown provider — nothing was asked, so nothing was spent", async () => {
      app = await buildAppWithRegistry(twoProviders().registry);

      await request(app.getHttpServer())
        .post("/ai/explain")
        .set("Authorization", `Bearer ${SECRET}`)
        .set("Content-Type", "application/json")
        .send({ sql: "SELECT 1", provider: "gpt-4o" });

      const res = await request(app.getHttpServer())
        .get("/history/export.jsonl")
        .set("Authorization", `Bearer ${SECRET}`);
      expect(res.text.trim()).toBe("");
    });
  });
});

// Ticket 0032 slice C — the streaming twins of the two routes above.
// They share the registry, the recorder and the error taxonomy; what is
// new on the wire is the framing and the fact that a refusal has to
// happen before the 200.
describe("AI streaming routes (0032 slice C)", () => {
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

  function frames(body: string): unknown[] {
    return body
      .split("\n\n")
      .filter((frame) => frame !== "")
      .map((frame) => JSON.parse(frame.replace(/^data: /, "")) as unknown);
  }

  async function exported(): Promise<HistoryRecord[]> {
    const res = await request(app.getHttpServer())
      .get("/history/export.jsonl")
      .set("Authorization", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    return res.text
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as HistoryRecord);
  }

  // A provider that streams for real, so the route is exercised against
  // an override rather than only against the one-chunk delegate.
  function streamingProvider(): AiProvider {
    return {
      ...stubProvider(),
      getCapabilities: () => ({ ...NO_AI_CAPABILITIES, streaming: true }),
      streamExplain: async function* () {
        yield { type: "message_start", tokensIn: 9, model: "stub-served" };
        yield { type: "text_delta", text: "It scans " };
        yield { type: "text_delta", text: "users." };
        yield { type: "usage", tokensIn: 9, tokensOut: 4 };
        yield { type: "message_stop", stopReason: "end_turn" };
      },
    };
  }

  it("streams a provider's own events as SSE frames", async () => {
    app = await buildAppWith(streamingProvider());

    const res = await request(app.getHttpServer())
      .post("/ai/explain/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT * FROM users" });

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toBe("text/event-stream; charset=utf-8");
    expect(frames(res.text)).toStrictEqual([
      { type: "message_start", tokensIn: 9, model: "stub-served" },
      { type: "text_delta", text: "It scans " },
      { type: "text_delta", text: "users." },
      { type: "usage", tokensIn: 9, tokensOut: 4 },
      { type: "message_stop", stopReason: "end_turn" },
    ]);
  });

  it("streams a non-streaming provider's answer as one chunk (CLAUDE.md rule 4)", async () => {
    // The panel's toggle must work against every configured provider,
    // not only the ones with an SSE transport.
    app = await buildAppWith(stubProvider());

    const res = await request(app.getHttpServer())
      .post("/ai/explain/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });

    expect(res.status).toBe(200);
    expect(frames(res.text)).toStrictEqual([
      { type: "message_start", tokensIn: null, model: "stub-model" },
      { type: "text_delta", text: "default explanation" },
      { type: "usage", tokensIn: null, tokensOut: null },
      { type: "message_stop", stopReason: null },
    ]);
  });

  it("streams suggestions too, schema and dialect passed through", async () => {
    const suggestSql = vi.fn().mockResolvedValue({ text: "SELECT 1;", model: "claude-x" });
    app = await buildAppWith(stubProvider({ suggestSql }));

    const res = await request(app.getHttpServer())
      .post("/ai/suggest/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ prompt: "every user", dialect: "postgres", schema: [{ name: "users" }] });

    expect(res.status).toBe(200);
    expect(frames(res.text)).toContainEqual({ type: "text_delta", text: "SELECT 1;" });
    expect(suggestSql).toHaveBeenCalledExactlyOnceWith({
      prompt: "every user",
      dialect: "postgres",
      schema: [{ schema: null, name: "users" }],
    });
  });

  it("streams with the described tables too — both routes share one normaliser", async () => {
    const suggestSql = vi.fn().mockResolvedValue({ text: "SELECT 1;", model: "claude-x" });
    app = await buildAppWith(stubProvider({ suggestSql }));

    const res = await request(app.getHttpServer())
      .post("/ai/suggest/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({
        prompt: "every user",
        full_schema: [
          {
            table: { schema: "public", name: "users" },
            columns: [
              {
                name: "id",
                declared_type: "integer",
                nullable: false,
                primary_key: true,
                ordinal: 1,
                default_value: null,
              },
            ],
            primary_key: ["id"],
          },
        ],
      });

    expect(res.status).toBe(200);
    expect(suggestSql).toHaveBeenCalledExactlyOnceWith({
      prompt: "every user",
      full_schema: [
        {
          table: { schema: "public", name: "users" },
          columns: [
            {
              name: "id",
              declared_type: "integer",
              nullable: false,
              primary_key: true,
              ordinal: 1,
              default_value: null,
            },
          ],
          primary_key: ["id"],
        },
      ],
    });
  });

  it("refuses a disabled deployment with the JSON envelope, not an event stream", async () => {
    app = await buildAppWith(undefined);

    const res = await request(app.getHttpServer())
      .post("/ai/explain/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });

    // The whole reason the use case resolves synchronously: a client
    // that gets 200 + text/event-stream here would have to discover the
    // refusal by parsing an error frame, and the panel would have shown
    // itself first.
    expect(res.status).toBe(404);
    expect(res.body).toStrictEqual({
      error: { category: "ai_disabled", message: "AI provider is not configured" },
    });
    expect(await exported()).toStrictEqual([]);
  });

  it("refuses an unconfigured provider name with 422 before the stream opens", async () => {
    app = await buildAppWith(stubProvider());

    const res = await request(app.getHttpServer())
      .post("/ai/suggest/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ prompt: "x", provider: "nope" });

    expect(res.status).toBe(422);
    expect(await exported()).toStrictEqual([]);
  });

  it("reports an upstream failure in band, after a 200 that cannot be taken back", async () => {
    const explain = vi.fn().mockRejectedValue(new AiError("upstream 503", { category: "network" }));
    app = await buildAppWith(stubProvider({ explain }));

    const res = await request(app.getHttpServer())
      .post("/ai/explain/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });

    expect(res.status).toBe(200);
    expect(frames(res.text)).toStrictEqual([
      { type: "error", category: "network", message: "upstream 503" },
    ]);
  });

  it("writes exactly one history record at the terminus, with the assembled text", async () => {
    app = await buildAppWith(streamingProvider());

    await request(app.getHttpServer())
      .post("/ai/explain/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT * FROM users" });

    const records = await exported();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      v: 2,
      kind: "ai",
      intent: "explain",
      prompt: "SELECT * FROM users",
      // Reassembled from the deltas — the record is of the answer, not
      // of the transport that carried it.
      response: "It scans users.",
      status: "ok",
      tokens_in: 9,
      tokens_out: 4,
      model: "stub-served",
      stop_reason: "end_turn",
      error: null,
    });
  });

  it("records a streamed upstream failure as status:'error'", async () => {
    const explain = vi.fn().mockRejectedValue(new AiError("upstream 503"));
    app = await buildAppWith(stubProvider({ explain }));

    await request(app.getHttpServer())
      .post("/ai/explain/stream")
      .set("Authorization", `Bearer ${SECRET}`)
      .set("Content-Type", "application/json")
      .send({ sql: "SELECT 1" });

    const records = await exported();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      status: "error",
      error: { category: "provider", message: "upstream 503" },
    });
  });
});
