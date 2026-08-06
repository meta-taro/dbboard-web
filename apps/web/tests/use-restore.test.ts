import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { rawFetch } from "../app/composables/internal/download";
import { useRestore } from "../app/composables/useRestore";

// Restore posts a `.sql` script as a raw `application/sql` body and reads the
// status code to tell the empty-target refusal from a real failure, so it
// goes through `rawFetch` rather than the `$fetch` wrapper — same reasoning
// as useDump.
vi.mock("../app/composables/internal/download", () => ({
  rawFetch: vi.fn(),
  saveBlob: vi.fn(),
}));

const mockFetch = vi.mocked(rawFetch);

type RestoreApi = ReturnType<typeof useRestore>;

function makeHarness(connectionId = "c1", apiBase = "http://test") {
  const holder: { api: RestoreApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useRestore(connectionId, { apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function planBody(overrides: Record<string, unknown> = {}) {
  return {
    statements_total: 4,
    ddl_count: 2,
    data_count: 2,
    unparsed_count: 0,
    existing_tables: [],
    is_target_empty: true,
    ...overrides,
  };
}

function outcomeBody(overrides: Record<string, unknown> = {}) {
  return {
    statements_run: 4,
    ddl_run: 2,
    data_run: 2,
    failures: [],
    cancelled: false,
    atomic: true,
    ...overrides,
  };
}

function errorResponse(status: number, category: string, message: string): Response {
  return jsonResponse({ error: { category, message } }, status);
}

const SCRIPT = "CREATE TABLE t (id int);\nINSERT INTO t VALUES (1);\n";

describe("useRestore", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not fetch on mount — a restore has no script until one is chosen", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.plan.value).toBeNull();
    wrapper.unmount();
  });

  it("posts the script to the plan route and lands in ready", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    const { Component, holder } = makeHarness("prod-pg");
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");

    const [url, init] = mockFetch.mock.calls[0]!;
    expect(url).toBe("http://test/connections/prod-pg/restore/plan");
    expect(init?.method).toBe("POST");
    expect(new Headers(init?.headers).get("Content-Type")).toBe("application/sql");
    expect(init?.body).toBe(SCRIPT);
    expect(holder.api!.state.value).toBe("ready");
    expect(holder.api!.plan.value?.statements_total).toBe(4);
    expect(holder.api!.filename.value).toBe("seed.sql");
    wrapper.unmount();
  });

  it("reports whether the target needs confirming", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(planBody({ existing_tables: ["public.a", "public.b"], is_target_empty: false })),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");

    expect(holder.api!.mustConfirm.value).toBe(true);
    // The gate starts closed: an unchecked box is not consent.
    expect(holder.api!.canRun.value).toBe(false);
    holder.api!.confirmed.value = true;
    expect(holder.api!.canRun.value).toBe(true);
    wrapper.unmount();
  });

  it("runs without confirmation into an empty target", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");

    expect(holder.api!.mustConfirm.value).toBe(false);
    expect(holder.api!.canRun.value).toBe(true);
    wrapper.unmount();
  });

  it("re-posts the script on run and carries the two options as query parameters", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(planBody({ existing_tables: ["public.a"], is_target_empty: false })),
    );
    mockFetch.mockResolvedValueOnce(jsonResponse(outcomeBody()));
    const { Component, holder } = makeHarness("prod-pg");
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");
    holder.api!.confirmed.value = true;
    holder.api!.onError.value = "continue";
    await holder.api!.run();

    const [url, init] = mockFetch.mock.calls[1]!;
    expect(url).toBe("http://test/connections/prod-pg/restore?confirmed=true&on_error=continue");
    // The plan is never sent back — the server re-plans from the script, so
    // a stale plan has no way to reach it (ADR-0065).
    expect(init?.body).toBe(SCRIPT);
    expect(holder.api!.state.value).toBe("done");
    expect(holder.api!.outcome.value?.statements_run).toBe(4);
    wrapper.unmount();
  });

  it("sends the defaults unconfirmed and stop-on-first-failure", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    mockFetch.mockResolvedValueOnce(jsonResponse(outcomeBody()));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");
    await holder.api!.run();

    expect(mockFetch.mock.calls[1]![0]).toBe(
      "http://test/connections/c1/restore?confirmed=false&on_error=stop",
    );
    wrapper.unmount();
  });

  it("refuses to run while the confirmation gate is closed", async () => {
    mockFetch.mockResolvedValueOnce(
      jsonResponse(planBody({ existing_tables: ["public.a"], is_target_empty: false })),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");
    await holder.api!.run();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(holder.api!.state.value).toBe("ready");
    wrapper.unmount();
  });

  it("surfaces a failed preflight as an error, not a plan", async () => {
    mockFetch.mockResolvedValueOnce(errorResponse(404, "capability", "unknown connection: c1"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");

    expect(holder.api!.state.value).toBe("failed");
    expect(holder.api!.plan.value).toBeNull();
    expect(holder.api!.lastError.value?.message).toContain("unknown connection");
    wrapper.unmount();
  });

  it("surfaces a failed run as an error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    mockFetch.mockResolvedValueOnce(errorResponse(400, "query", "restore transaction failed"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");
    await holder.api!.run();

    expect(holder.api!.state.value).toBe("failed");
    expect(holder.api!.lastError.value?.message).toContain("restore transaction failed");
    wrapper.unmount();
  });

  it("keeps a partial run's outcome — failures are a result, not an error", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        outcomeBody({
          statements_run: 3,
          atomic: false,
          failures: [{ index: 2, message: 'relation "t" does not exist' }],
        }),
      ),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");
    await holder.api!.run();

    expect(holder.api!.state.value).toBe("done");
    expect(holder.api!.lastError.value).toBeNull();
    expect(holder.api!.outcome.value?.failures).toHaveLength(1);
    wrapper.unmount();
  });

  it("cancels by aborting the request, and reads the abort as cancelled", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    // The server observes the socket closing and rolls back; the client
    // never receives a body, so there are no counts to report.
    mockFetch.mockImplementationOnce(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("aborted", "AbortError"));
          });
        }),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");
    const pending = holder.api!.run();
    await flushPromises();
    expect(holder.api!.state.value).toBe("running");

    holder.api!.cancel();
    await pending;

    expect(holder.api!.state.value).toBe("cancelled");
    // An abort is the user's own doing, so it is not an error banner.
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("resets back to idle, forgetting the script it was holding", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody()));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "seed.sql");
    holder.api!.confirmed.value = true;
    holder.api!.reset();

    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.plan.value).toBeNull();
    expect(holder.api!.filename.value).toBeNull();
    expect(holder.api!.confirmed.value).toBe(false);

    // With no script held, a run cannot fall through to the network.
    await holder.api!.run();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("drops a stale plan when a second file is chosen", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse(planBody({ statements_total: 4 })));
    mockFetch.mockResolvedValueOnce(
      jsonResponse(
        planBody({ statements_total: 9, existing_tables: ["public.a"], is_target_empty: false }),
      ),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.preflight(SCRIPT, "first.sql");
    holder.api!.confirmed.value = true;
    await holder.api!.preflight("SELECT 1;", "second.sql");

    expect(holder.api!.plan.value?.statements_total).toBe(9);
    expect(holder.api!.filename.value).toBe("second.sql");
    // Consent was given for the first file's plan; it does not carry over.
    expect(holder.api!.confirmed.value).toBe(false);
    wrapper.unmount();
  });
});
