import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ROW_CAP } from "../../src/domain/limits";
import {
  compareEnvelopes,
  normalizeContentType,
  type ConformanceResponse,
} from "./helpers/compare";
import { startDesktopServer, type DesktopServer } from "./helpers/desktop-server";
import { startSharedPostgres, type PostgresFixture } from "./helpers/postgres-fixture";
import { startWebServer, type WebServer } from "./helpers/web-server";

// Contract-conformance battery (ticket 0005 § 3). Runs the same battery
// of requests against the desktop loopback server and the in-process
// web server, asserting deep-equal responses modulo `capabilities.id`.
//
// Skip gate: requires both `DBBOARD_SERVER_BIN` (desktop binary path)
// and a reachable Docker daemon (for the shared Postgres). When either
// is missing the suite skips cleanly — local dev without Rust toolchain,
// CI without a daemon, and Windows hosts where `DOCKER_HOST` is unset
// all hit this gate gracefully. The desktop conformance suite mirrors
// this skip gate on its side.

const desktopBinary = process.env.DBBOARD_SERVER_BIN;

interface Endpoint {
  desktop: string;
  web: string;
}

describe.runIf(Boolean(desktopBinary))("contract conformance (desktop ⇔ web)", () => {
  let fixture: PostgresFixture | null = null;
  let desktop: DesktopServer | null = null;
  let web: WebServer | null = null;
  let desktopConnectionId: string | null = null;
  let skipReason: string | null = null;

  beforeAll(async () => {
    try {
      fixture = await startSharedPostgres();
    } catch (e) {
      skipReason = `Docker not available (${e instanceof Error ? e.message : String(e)})`;

      console.warn(`[conformance] SKIPPING: ${skipReason}`);
      return;
    }

    web = await startWebServer(fixture);
    desktop = await startDesktopServer({
      binaryPath: desktopBinary as string,
      fixture,
    });
    desktopConnectionId = await desktop.registerPostgres();

    // Seed an integ fixture table so the populated /tables case has
    // something to look at. Both sides see the same Postgres, so the
    // CREATE TABLE only needs to run once.
    await sendJson(`${web.origin}/connections/${web.connectionId}/query`, {
      sql: "CREATE TABLE IF NOT EXISTS conformance_fixture (id int primary key)",
    });
  });

  afterAll(async () => {
    if (desktop) await desktop.stop();
    if (web) await web.close();
    if (fixture) await fixture.container.stop();
  });

  // Per-case helper: collects { status, content-type, body, text } for
  // both servers so the compare helper can branch on JSON vs plain text
  // without having to re-parse a stream.
  async function fetchBoth(
    endpoint: Endpoint,
    init: RequestInit = {},
  ): Promise<{ desktopRes: ConformanceResponse; webRes: ConformanceResponse }> {
    if (!desktop || !web) throw new Error("servers not initialised");
    const dRaw = await fetch(`${desktop.origin}${endpoint.desktop}`, init);
    const wRaw = await fetch(`${web.origin}${endpoint.web}`, init);
    return {
      desktopRes: await materialise(dRaw),
      webRes: await materialise(wRaw),
    };
  }

  // ---- Battery cases (see ticket § Request battery) ----------------

  it("01 — GET /health is the liveness baseline", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { desktopRes, webRes } = await fetchBoth({ desktop: "/health", web: "/health" });
    expect(compareEnvelopes(desktopRes, webRes)).toBeNull();
  });

  it("02 — GET /tables on the default adapter returns the same shape", async (ctx) => {
    if (skipReason) return ctx.skip();
    // Both sides have their default adapter wired to whatever the binary
    // / app module declares. The contract only pins the *shape* of the
    // response (`{ tables: string[] }`); the contents depend on which
    // adapter is default. We pin only the shape so this case doesn't
    // become a property of the deployment.
    const { desktopRes, webRes } = await fetchBoth({ desktop: "/tables", web: "/tables" });
    expect(desktopRes.status).toBe(webRes.status);
    expect(normalizeContentType(desktopRes.contentType)).toBe(
      normalizeContentType(webRes.contentType),
    );
    expect(desktopRes.body).toMatchObject({ tables: expect.any(Array) });
    expect(webRes.body).toMatchObject({ tables: expect.any(Array) });
  });

  it("03 — GET /capabilities matches modulo the adapter id", async (ctx) => {
    if (skipReason) return ctx.skip();
    const { desktopRes, webRes } = await fetchBoth({
      desktop: "/capabilities",
      web: "/capabilities",
    });
    expect(compareEnvelopes(desktopRes, webRes, { ignoreTopLevelKeys: ["id"] })).toBeNull();
  });

  it("04 — POST /query SELECT 1 → identical row data", async (ctx) => {
    if (skipReason || !desktopConnectionId || !web) return ctx.skip();
    const init = jsonBody({ sql: "SELECT 1 AS one" });
    const { desktopRes, webRes } = await fetchBoth(
      {
        desktop: `/connections/${desktopConnectionId}/query`,
        web: `/connections/${web.connectionId}/query`,
      },
      init,
    );
    expect(compareEnvelopes(desktopRes, webRes)).toBeNull();
  });

  it("05 — POST /query value-union coverage → identical row data", async (ctx) => {
    if (skipReason || !desktopConnectionId || !web) return ctx.skip();
    const init = jsonBody({
      sql: "SELECT NULL::int AS a, 1::int AS b, 1.5::float AS c, 'hi' AS d, '\\xff'::bytea AS e",
    });
    const { desktopRes, webRes } = await fetchBoth(
      {
        desktop: `/connections/${desktopConnectionId}/query`,
        web: `/connections/${web.connectionId}/query`,
      },
      init,
    );
    expect(compareEnvelopes(desktopRes, webRes)).toBeNull();
  });

  it("06 — malformed JSON → 400 plain text on both sides", async (ctx) => {
    if (skipReason) return ctx.skip();
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    };
    const { desktopRes, webRes } = await fetchBoth({ desktop: "/query", web: "/query" }, init);
    expect(desktopRes.status).toBe(400);
    expect(webRes.status).toBe(400);
    expect(compareEnvelopes(desktopRes, webRes)).toBeNull();
  });

  it("07 — body without sql field → 422 query envelope on both sides", async (ctx) => {
    if (skipReason || !desktopConnectionId || !web) return ctx.skip();
    const init = jsonBody({ oops: 1 });
    const { desktopRes, webRes } = await fetchBoth(
      {
        desktop: `/connections/${desktopConnectionId}/query`,
        web: `/connections/${web.connectionId}/query`,
      },
      init,
    );
    expect(desktopRes.status).toBe(422);
    expect(webRes.status).toBe(422);
    // Validation messages are framework-specific (Nest's class-validator
    // vs whatever the desktop side uses); only the status code is pinned
    // by the contract for the 422 envelope on a missing required field.
    expect(normalizeContentType(desktopRes.contentType)).toBe(
      normalizeContentType(webRes.contentType),
    );
  });

  it("08 — Content-Type: text/plain → 415 plain text on both sides", async (ctx) => {
    if (skipReason) return ctx.skip();
    const init: RequestInit = {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: "SELECT 1",
    };
    const { desktopRes, webRes } = await fetchBoth({ desktop: "/query", web: "/query" }, init);
    expect(desktopRes.status).toBe(415);
    expect(webRes.status).toBe(415);
    expect(compareEnvelopes(desktopRes, webRes)).toBeNull();
  });

  it("09 — 65 KiB body → 413 plain text on both sides", async (ctx) => {
    if (skipReason || !desktopConnectionId || !web) return ctx.skip();
    const init = jsonBody({ sql: "SELECT '" + "a".repeat(65 * 1024) + "'" });
    const { desktopRes, webRes } = await fetchBoth(
      {
        desktop: `/connections/${desktopConnectionId}/query`,
        web: `/connections/${web.connectionId}/query`,
      },
      init,
    );
    expect(desktopRes.status).toBe(413);
    expect(webRes.status).toBe(413);
    expect(compareEnvelopes(desktopRes, webRes)).toBeNull();
  });

  it(`10 — generate_series above ROW_CAP → 400 query envelope mentioning the cap`, async (ctx) => {
    if (skipReason || !desktopConnectionId || !web) return ctx.skip();
    const init = jsonBody({ sql: `SELECT generate_series(1, ${ROW_CAP + 1})` });
    const { desktopRes, webRes } = await fetchBoth(
      {
        desktop: `/connections/${desktopConnectionId}/query`,
        web: `/connections/${web.connectionId}/query`,
      },
      init,
    );
    expect(desktopRes.status).toBe(400);
    expect(webRes.status).toBe(400);
    expect((desktopRes.body as { error?: { category?: string } }).error?.category).toBe("query");
    expect((webRes.body as { error?: { category?: string } }).error?.category).toBe("query");
    // Wording is not pinned, but the contract demands the intent — both
    // sides must surface the cap in the message so the UI can explain
    // why the grid is empty.
    const desktopMsg = String((desktopRes.body as { error?: { message?: string } }).error?.message);
    const webMsg = String((webRes.body as { error?: { message?: string } }).error?.message);
    expect(desktopMsg).toMatch(/10,?000.*row.*cap/i);
    expect(webMsg).toMatch(/10,?000.*row.*cap/i);
  });

  it("11 — divide by zero → 400 query envelope on both sides", async (ctx) => {
    if (skipReason || !desktopConnectionId || !web) return ctx.skip();
    const init = jsonBody({ sql: "SELECT 1/0" });
    const { desktopRes, webRes } = await fetchBoth(
      {
        desktop: `/connections/${desktopConnectionId}/query`,
        web: `/connections/${web.connectionId}/query`,
      },
      init,
    );
    expect(desktopRes.status).toBe(400);
    expect(webRes.status).toBe(400);
    expect((desktopRes.body as { error?: { category?: string } }).error?.category).toBe("query");
    expect((webRes.body as { error?: { category?: string } }).error?.category).toBe("query");
  });
});

if (!desktopBinary) {
  describe("contract conformance (desktop ⇔ web)", () => {
    it.skip("DBBOARD_SERVER_BIN not set — see ticket 0005 § Sourcing the desktop server", () => {
      // Intentional skip: a maintainer runs this via `pnpm conformance`
      // with the desktop binary on hand, or CI pins a release artifact
      // before invoking. Local default is "skip cleanly, do not fail".
    });
  });
}

// ---- helpers ------------------------------------------------------

async function materialise(res: Response): Promise<ConformanceResponse> {
  const contentType = res.headers.get("content-type") ?? "";
  const text = await res.text();
  let body: unknown = {};
  if (normalizeContentType(contentType) === "application/json" && text.length > 0) {
    try {
      body = JSON.parse(text);
    } catch {
      // Mis-advertised JSON — preserve the raw text for debug output.
      body = { _malformed: text };
    }
  }
  return { status: res.status, contentType, body, text };
}

function jsonBody(payload: unknown): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  };
}

async function sendJson(url: string, payload: unknown): Promise<Response> {
  return fetch(url, jsonBody(payload));
}
