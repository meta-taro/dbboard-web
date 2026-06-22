/**
 * Shared Playwright fixtures for the Phase 4 slice 4 E2E suite.
 *
 * The whole suite runs hermetically: every `useConnections` /
 * `useQueryExecution` HTTP call is intercepted at the browser layer via
 * `page.route()`. The NestJS API never runs under Playwright — its own
 * contract conformance battery in apps/api/tests/conformance/ already
 * proves the wire format. The mock here only needs to be schema-compatible
 * with `useQueryExecution.QueryResult`, not byte-for-byte with the API.
 *
 * `mockApi(page)` returns a live state handle: tests assert against
 * `state.registerCalls` / `state.queryCalls` to prove the IME-composition
 * guard suppressed dispatch, or that the run button fired exactly once.
 *
 * `apiOrigin` mirrors `runtimeConfig.public.apiBaseUrl` in
 * apps/web/nuxt.config.ts. Since issue 0016 the composables call the
 * same-origin proxy at /api/proxy/* (the proxy injects the bearer
 * secret server-side), so the default origin is the Playwright baseURL
 * + that prefix. The NestJS API never starts under Playwright.
 */

import { expect as baseExpect, test as base, type Page } from "@playwright/test";

/**
 * Nuxt dev mode keeps a Vite HMR connection open after the page renders,
 * so the page's `load` event (Playwright's default `waitUntil`) never
 * fires within the test timeout. Switching to `domcontentloaded` returns
 * as soon as the markup is parsed — every spec uses this helper instead
 * of `page.goto` directly.
 *
 * Under Nuxt SSR the form HTML lands in the DOM before the client bundle
 * hydrates Vue, so a `toBeVisible` check on a form element can pass while
 * the `@submit.prevent` listener still isn't attached. `gotoApp` polls
 * `#__nuxt.__vue_app__` to confirm Vue has actually mounted before the
 * test starts driving the page.
 */
export async function gotoApp(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const root = document.querySelector("#__nuxt") as unknown as {
        __vue_app__?: unknown;
      } | null;
      return root?.__vue_app__ !== undefined;
    },
    null,
    { timeout: 20_000 },
  );
}

export interface MockedConnection {
  id: string;
  label: string;
  driver: string;
}

export type MockedCellValue = number | string | null | { $blob: string };

export interface MockedQueryResult {
  columns: Array<{ name: string; declared_type: string | null }>;
  rows: ReadonlyArray<ReadonlyArray<MockedCellValue>>;
  rows_affected: number;
}

export interface MockApiOptions {
  initialConnections?: MockedConnection[];
  queryResponse?: MockedQueryResult;
  apiOrigin?: string;
}

export interface MockApiState {
  readonly registerCalls: number;
  readonly queryCalls: number;
  readonly listCalls: number;
  readonly connections: ReadonlyArray<MockedConnection>;
}

const DEFAULT_ORIGIN = "http://127.0.0.1:3000/api/proxy";

const DEFAULT_QUERY_RESPONSE: MockedQueryResult = {
  columns: [
    { name: "id", declared_type: "integer" },
    { name: "label", declared_type: "text" },
  ],
  rows: [
    [1, "alpha"],
    [2, "beta"],
  ],
  rows_affected: 2,
};

export async function mockApi(page: Page, opts: MockApiOptions = {}): Promise<MockApiState> {
  const origin = opts.apiOrigin ?? DEFAULT_ORIGIN;
  const queryResponse = opts.queryResponse ?? DEFAULT_QUERY_RESPONSE;
  const state = {
    registerCalls: 0,
    queryCalls: 0,
    listCalls: 0,
    connections: opts.initialConnections ? [...opts.initialConnections] : [],
  };

  // `GET /connections` and `POST /connections` share the exact URL — the
  // handler dispatches on method.
  await page.route(`${origin}/connections`, async (route) => {
    const req = route.request();
    if (req.method() === "GET") {
      state.listCalls++;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ connections: state.connections }),
      });
      return;
    }
    if (req.method() === "POST") {
      state.registerCalls++;
      const body = req.postDataJSON() as { label: string; driver: string };
      const id = `mock-conn-${state.connections.length + 1}`;
      state.connections.push({ id, label: body.label, driver: body.driver });
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify({ id }),
      });
      return;
    }
    await route.fallback();
  });

  // `POST /connections/:id/query` — the IME-guard spec asserts the counter
  // stays at zero across the composition-suppressed keydowns.
  await page.route(`${origin}/connections/*/query`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.fallback();
      return;
    }
    state.queryCalls++;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(queryResponse),
    });
  });

  return state as MockApiState;
}

export const test = base;
export const expect = baseExpect;
