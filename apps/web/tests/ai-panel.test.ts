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

// Ticket 0032 slice B — the panel asks which providers exist as soon as
// it mounts, so every mount consumes one queued response before the one
// the test is about. `mountPanel` answers that question and settles it,
// leaving the mock queue empty for the test's own turn.
//
// The default answer is a single provider, which is the Stage 1
// deployment: one configured provider means no choice to make, so the
// panel renders no selector and its requests are byte-identical to the
// ones made before this slice existed. That is what lets the cases
// below keep asserting exact bodies.
const ONE_PROVIDER = {
  providers: [
    { id: "anthropic", name: "anthropic", kind: "anthropic", model: "claude-x", default: true },
  ],
};

const TWO_PROVIDERS = {
  providers: [
    { id: "fast", name: "Fast", kind: "anthropic", model: "claude-sonnet-4-6", default: false },
    { id: "deep", name: "Deep", kind: "anthropic", model: "claude-opus-4-8", default: true },
  ],
};

async function mountPanel(
  props: Record<string, unknown> = baseProps,
  providers: unknown = ONE_PROVIDER,
) {
  mockFetch.mockResolvedValueOnce(providers);
  const wrapper = mount(AiPanel, { props });
  await flushPromises();
  return wrapper;
}

function lastBody(): Record<string, unknown> {
  return mockFetch.mock.lastCall?.[1]?.body as Record<string, unknown>;
}

describe("AiPanel", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the panel with the ai-panel testid and both sections", async () => {
    const wrapper = await mountPanel();
    expect(wrapper.find("[data-testid='ai-panel']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-explain-section']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ai-suggest-section']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("clicking explain POSTs the currentSql prop and renders the explain response", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "This selects 1.", model: "claude-x" });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
      method: "POST",
      body: { sql: "SELECT 1" },
    });
    const explainOutput = wrapper.find("[data-testid='ai-explain-output']");
    expect(explainOutput.exists()).toBe(true);
    expect(explainOutput.text()).toContain("This selects 1.");
    wrapper.unmount();
  });

  it("clicking suggest POSTs the prompt textarea value and renders the suggest response", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "SELECT COUNT(*) FROM users;", model: "claude-y" });

    await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count all users");
    await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
    await flushPromises();

    expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/suggest", {
      method: "POST",
      body: { prompt: "count all users" },
    });
    const suggestOutput = wrapper.find("[data-testid='ai-suggest-output']");
    expect(suggestOutput.exists()).toBe(true);
    expect(suggestOutput.text()).toContain("SELECT COUNT(*) FROM users;");
    wrapper.unmount();
  });

  it("passes the dialect input through to both methods", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

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
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "SELECT 42;", model: "m" });

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
    const wrapper = await mountPanel();
    mockFetch.mockResolvedValueOnce({ text: "explanation", model: "m" });

    await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-suggest-insert']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the disabled-mode panel when the wire returns ai_disabled", async () => {
    const wrapper = await mountPanel();
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
    });

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
    const wrapper = await mountPanel();
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_provider", message: "Upstream model unavailable" } },
    });

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
    const wrapper = await mountPanel();
    let resolve: ((value: unknown) => void) | null = null;
    mockFetch.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );

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
  // ADR-0028 Decision 8 (terse half). The panel does not introspect: it
  // renders whatever list the page hands it, which keeps it as
  // connection-agnostic as the composable behind it.
  describe("table list", () => {
    const tables = [
      { schema: "public", name: "users" },
      { schema: null, name: "orders" },
    ];

    it("sends the tables prop with a suggest", async () => {
      const wrapper = await mountPanel({ ...baseProps, tables });
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("recent orders");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/suggest", {
        method: "POST",
        body: { prompt: "recent orders", schema: tables },
      });
      wrapper.unmount();
    });

    it("sends nothing about tables when the prop is absent", async () => {
      const wrapper = await mountPanel();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("recent orders");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(lastBody()).not.toHaveProperty("schema");
      wrapper.unmount();
    });

    it("leaves explain alone — the SQL is the context there", async () => {
      const wrapper = await mountPanel({ ...baseProps, tables });
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1" },
      });
      wrapper.unmount();
    });
  });

  // Ticket 0032 slice B. Desktop puts the provider list in a settings
  // window; web has no settings window and no place to accept a key, so
  // the list is the operator's env block and the only thing left for the
  // user to do is pick from it.
  describe("provider selector", () => {
    it("asks the server which providers exist as soon as it mounts", async () => {
      const wrapper = await mountPanel();
      expect(mockFetch).toHaveBeenCalledWith("http://test/ai/providers");
      wrapper.unmount();
    });

    it("offers one option per configured provider, labelled by name", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);

      const select = wrapper.find("[data-testid='ai-provider-select']");
      expect(select.exists()).toBe(true);
      const options = select.findAll("option");
      expect(options.map((o) => o.attributes("value"))).toEqual(["fast", "deep"]);
      expect(options.map((o) => o.text())).toEqual(["Fast", "Deep"]);
      wrapper.unmount();
    });

    it("starts on the provider the server marked default", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      expect(
        wrapper.find<HTMLSelectElement>("[data-testid='ai-provider-select']").element.value,
      ).toBe("deep");
      wrapper.unmount();
    });

    it("sends the chosen provider with an explain", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-provider-select']").setValue("fast");
      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1", provider: "fast" },
      });
      wrapper.unmount();
    });

    it("sends the chosen provider with a suggest", async () => {
      const wrapper = await mountPanel(baseProps, TWO_PROVIDERS);
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      await wrapper.find("[data-testid='ai-provider-select']").setValue("fast");
      await wrapper.find("[data-testid='ai-suggest-prompt']").setValue("count users");
      await wrapper.find("[data-testid='ai-suggest-button']").trigger("click");
      await flushPromises();

      expect(lastBody().provider).toBe("fast");
      wrapper.unmount();
    });

    // One provider is not a choice. Rendering a select with a single
    // option would ask the user to confirm something they cannot change,
    // and naming it on the wire would make every Stage 1 deployment's
    // requests change shape for no reason the server can act on.
    it("renders no selector, and names nobody, when there is only one provider", async () => {
      const wrapper = await mountPanel();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      expect(wrapper.find("[data-testid='ai-provider-select']").exists()).toBe(false);

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(lastBody()).not.toHaveProperty("provider");
      wrapper.unmount();
    });

    // The 404 from /ai/providers says the same thing the 404 from
    // /ai/explain says, and arrives without the user pressing anything.
    it("shows the disabled notice straight away when the deployment has no AI", async () => {
      mockFetch.mockRejectedValueOnce({
        data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
      });
      const wrapper = mount(AiPanel, { props: baseProps });
      await flushPromises();

      expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(true);
      expect(wrapper.find("[data-testid='ai-provider-select']").exists()).toBe(false);
      expect(
        wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
      ).toBe(true);
      wrapper.unmount();
    });

    // A provider list that fails to load is not a reason to make the
    // panel unusable: the server still has a default, and a request that
    // names nobody still reaches it.
    it("stays usable when the provider list cannot be fetched", async () => {
      mockFetch.mockRejectedValueOnce(new Error("Network down"));
      const wrapper = mount(AiPanel, { props: baseProps });
      await flushPromises();
      mockFetch.mockResolvedValueOnce({ text: "ok", model: "m" });

      expect(wrapper.find("[data-testid='ai-disabled-notice']").exists()).toBe(false);
      expect(
        wrapper.find<HTMLButtonElement>("[data-testid='ai-explain-button']").element.disabled,
      ).toBe(false);

      await wrapper.find("[data-testid='ai-explain-button']").trigger("click");
      await flushPromises();

      expect(mockFetch).toHaveBeenLastCalledWith("http://test/ai/explain", {
        method: "POST",
        body: { sql: "SELECT 1" },
      });
      wrapper.unmount();
    });
  });
});
