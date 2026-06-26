import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../app/composables/internal/http";
import AiPanel from "../app/components/AiPanel.vue";

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

const baseProps = { currentSql: "SELECT 1", apiBase: "http://test" };

describe("AiPanel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the panel with the ai-panel testid and both sections", () => {
    const wrapper = mount(AiPanel, { props: baseProps });
    expect(wrapper.find("[data-testid='ai-panel']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-explain-section']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-suggest-section']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("clicking explain POSTs the currentSql prop and renders the explain response", async () => {
    mockFetch.mockResolvedValueOnce({ text: "This selects 1.", model: "claude-x" });
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });
    const explainOutput = wrapper.find("[data-testid='ai-explain-output']");
    expect(explainOutput.exists()).toBe(true);
    expect(explainOutput.text()).toContain("This selects 1.");
    wrapper.unmount();
  });

  it("clicking suggest POSTs the prompt textarea value and renders the suggest response", async () => {
    mockFetch.mockResolvedValueOnce({ text: "SELECT COUNT(*) FROM users;", model: "claude-y" });
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count all users");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "count all users" },
    });
    const suggestOutput = wrapper.find("[data-testid='ai-suggest-output']");
    expect(suggestOutput.exists()).toBe(true);
    expect(suggestOutput.text()).toContain("SELECT COUNT(*) FROM users;");
    wrapper.unmount();
  });

  it("passes the dialect input through to both methods", async () => {
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-dialect-input']").setValue("postgres");
    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1", dialect: "postgres" },
    });

    mockFetch.mockResolvedValueOnce({ text: "ok2", model: "m" });
    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("hello");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "hello", dialect: "postgres" },
    });
    wrapper.unmount();
  });

  it("suggest output exposes an insert button that emits the response text", async () => {
    mockFetch.mockResolvedValueOnce({ text: "SELECT 42;", model: "m" });
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("whatever");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    await wrapper.find("[data-testid='ai-suggest-insert']").trigger("click");
    const emitted = wrapper.emitted("insert");
    expect(emitted).toBeDefined();
    expect(emitted![0]).toEqual(["SELECT 42;"]);
    wrapper.unmount();
  });

  it("explain output has no insert button (only suggest output does)", async () => {
    mockFetch.mockResolvedValueOnce({ text: "explanation", model: "m" });
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-suggest-insert']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the disabled-mode panel when the wire returns ai_disabled", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
    });
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-error']").exists()).toBe(false);
    // Both action buttons disabled once we know the feature is off.
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
    ).toBe(true);
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-suggest-button']").element.disabled,
    ).toBe(true);
    wrapper.unmount();
  });

  it("renders a generic error banner for non-ai_disabled errors", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_provider", message: "Upstream model unavailable" } },
    });
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("anything");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    const banner = wrapper.find("[data-testid='ai-error']");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("error.prefix.ai-provider");
    expect(banner.text()).toContain("Upstream model unavailable");
    expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("disables both buttons while a request is in flight", async () => {
    let resolve: ((value: unknown) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const wrapper = mount(AiPanel, { props: baseProps });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-loading']").exists()).toBe(true);
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
    ).toBe(true);
    expect(
      wrapper.find<HTMLButtonElement>("[data-testid='ai-suggest-button']").element.disabled,
    ).toBe(true);

    resolve!({ text: "done", model: "m" });
    await flushPromises();
    expect(wrapper.find("[data-testid='ai-loading']").exists()).toBe(false);
    wrapper.unmount();
  });
});
