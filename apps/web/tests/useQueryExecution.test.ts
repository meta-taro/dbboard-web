import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useQueryExecution } from "../app/composables/useQueryExecution";

// vi.mock is hoisted by Vitest above all imports — same indirection swap
// as useConnections.test.ts so the composable never reaches the network.
vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type ExecutionApi = ReturnType<typeof useQueryExecution>;

function makeHarness(connectionId: string, apiBase = "http://test") {
  const holder: { api: ExecutionApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useQueryExecution(connectionId, { apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

const okResult = {
  columns: [{ name: "x", declared_type: "INTEGER" }],
  rows: [[1]],
  rows_affected: 0,
};

describe("useQueryExecution", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not call apiFetch on mount (run is user-initiated only)", async () => {
    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    expect(mockFetch).not.toHaveBeenCalled();
    expect(api.result.value).toBeNull();
    expect(api.state.value).toBe("idle");
    expect(api.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("POSTs { sql } to /connections/:id/query and populates result on success", async () => {
    mockFetch.mockResolvedValueOnce(okResult);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.run("SELECT 1 AS x");

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: "SELECT 1 AS x" },
    });
    expect(api.result.value).toEqual(okResult);
    expect(api.state.value).toBe("idle");
    expect(api.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("flips state to 'loading' during the in-flight call and back to 'idle' on success", async () => {
    let resolveFetch!: (value: typeof okResult) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFetch = resolve;
      }),
    );

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    const pending = api.run("SELECT 1");
    await flushPromises();
    expect(api.state.value).toBe("loading");

    resolveFetch(okResult);
    await pending;
    expect(api.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("surfaces the categorised error envelope on lastError and flips state to 'error'", async () => {
    mockFetch.mockRejectedValueOnce({
      data: {
        error: { category: "query", message: "syntax error at or near 'SELEC'" },
      },
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.run("SELEC 1");

    expect(api.state.value).toBe("error");
    expect(api.lastError.value).toEqual({
      category: "query",
      message: "syntax error at or near 'SELEC'",
      i18nKey: "error.prefix.query",
    });
    wrapper.unmount();
  });

  it("normalises 'type_conversion' (backend underscore) to the hyphenated i18n key", async () => {
    mockFetch.mockRejectedValueOnce({
      data: {
        error: { category: "type_conversion", message: "cannot convert NaN" },
      },
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.run("SELECT 'NaN'::float8");

    expect(api.lastError.value?.i18nKey).toBe("error.prefix.type-conversion");
    expect(api.lastError.value?.category).toBe("type_conversion");
    wrapper.unmount();
  });

  it("falls back to category='connection' when the envelope is unparseable", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.run("SELECT 1");

    expect(api.state.value).toBe("error");
    expect(api.lastError.value?.category).toBe("connection");
    expect(api.lastError.value?.i18nKey).toBe("error.prefix.connection");
    expect(api.lastError.value?.message).toContain("Network down");
    wrapper.unmount();
  });

  it("a second successful run() replaces result (no stale data)", async () => {
    const first = {
      columns: [{ name: "x", declared_type: "INTEGER" }],
      rows: [[1]],
      rows_affected: 0,
    };
    const second = {
      columns: [{ name: "y", declared_type: "TEXT" }],
      rows: [["hello"], ["world"]],
      rows_affected: 0,
    };
    mockFetch.mockResolvedValueOnce(first);
    mockFetch.mockResolvedValueOnce(second);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.run("SELECT 1 AS x");
    expect(api.result.value).toEqual(first);

    await api.run("SELECT 'hello' AS y UNION SELECT 'world'");
    expect(api.result.value).toEqual(second);
    wrapper.unmount();
  });

  it("leaves the previous result untouched when a subsequent run fails", async () => {
    mockFetch.mockResolvedValueOnce(okResult);
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "query", message: "boom" } },
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.run("SELECT 1 AS x");
    await api.run("SELEC 2");

    expect(api.result.value).toEqual(okResult);
    expect(api.state.value).toBe("error");
    expect(api.lastError.value?.category).toBe("query");
    wrapper.unmount();
  });
});
