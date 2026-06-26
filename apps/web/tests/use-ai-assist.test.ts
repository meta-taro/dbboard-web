import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useAiAssist } from "../app/composables/useAiAssist";

// Phase 6 Slice 3 (ticket 0022) — UI-layer composable wrapping the
// Slice 2 POST /ai/explain + POST /ai/suggest routes. AI routes are
// connection-agnostic (the SQL lives in the body), so unlike
// useSchemaBrowser / useQueryHistory this composable takes no
// connectionId. State is shared across both methods because the panel
// shows one shared spinner and disables both buttons while one call is
// in flight.

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type AiApi = ReturnType<typeof useAiAssist>;

function makeHarness(apiBase = "http://test") {
  const holder: { api: AiApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useAiAssist({ apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

describe("useAiAssist", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts idle with no response and no error", () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastResponse.value).toBeNull();
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("explain() POSTs {sql} to /ai/explain and stores response with mode=explain", async () => {
    mockFetch.mockResolvedValueOnce({ text: "This selects everything.", model: "claude-x" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });
    expect(holder.api!.lastResponse.value).toEqual({
      text: "This selects everything.",
      model: "claude-x",
      mode: "explain",
    });
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("explain() includes dialect when provided", async () => {
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1", "postgres");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1", dialect: "postgres" },
    });
    wrapper.unmount();
  });

  it("suggestSql() POSTs {prompt} to /ai/suggest and stores response with mode=suggest", async () => {
    mockFetch.mockResolvedValueOnce({ text: "SELECT COUNT(*) FROM users;", model: "claude-y" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.suggestSql("count all users");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "count all users" },
    });
    expect(holder.api!.lastResponse.value).toEqual({
      text: "SELECT COUNT(*) FROM users;",
      model: "claude-y",
      mode: "suggest",
    });
    wrapper.unmount();
  });

  it("suggestSql() includes dialect when provided", async () => {
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.suggestSql("count users", "sqlite");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "count users", dialect: "sqlite" },
    });
    wrapper.unmount();
  });

  it("transitions through loading → idle on success", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const pending = holder.api!.explain("SELECT 1");
    expect(holder.api!.state.value).toBe("loading");

    resolve!({ text: "x", model: "m" });
    await pending;
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("surfaces an ai_disabled envelope as a CategorisedError", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();

    expect(holder.api!.state.value).toBe("error");
    expect(holder.api!.lastError.value?.category).toBe("ai_disabled");
    expect(holder.api!.lastError.value?.i18nKey).toBe("error.prefix.ai-disabled");
    expect(holder.api!.lastResponse.value).toBeNull();
    wrapper.unmount();
  });

  it("surfaces an ai_provider envelope as a CategorisedError", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_provider", message: "Upstream model unavailable" } },
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.suggestSql("anything");
    await flushPromises();

    expect(holder.api!.state.value).toBe("error");
    expect(holder.api!.lastError.value?.category).toBe("ai_provider");
    expect(holder.api!.lastError.value?.i18nKey).toBe("error.prefix.ai-provider");
    wrapper.unmount();
  });

  it("clears lastError on a successful call after a failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();
    expect(holder.api!.lastError.value).not.toBeNull();

    await holder.api!.explain("SELECT 2");
    await flushPromises();
    expect(holder.api!.lastError.value).toBeNull();
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("replaces the previous response on a subsequent successful call", async () => {
    mockFetch.mockResolvedValueOnce({ text: "first", model: "m1" });
    mockFetch.mockResolvedValueOnce({ text: "second", model: "m2" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.explain("SELECT 1");
    await flushPromises();
    expect(holder.api!.lastResponse.value?.text).toBe("first");

    await holder.api!.suggestSql("hello");
    await flushPromises();
    expect(holder.api!.lastResponse.value).toEqual({
      text: "second",
      model: "m2",
      mode: "suggest",
    });
    wrapper.unmount();
  });
});
