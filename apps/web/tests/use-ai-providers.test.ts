import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useAiProviders } from "../app/composables/useAiProviders";

// Ticket 0032 slice B — the panel can offer a choice of provider, so it
// needs to know which ones this deployment has. `GET /ai/providers`
// answers that, and answers 404 `ai_disabled` when there are none: the
// same signal the two call routes give, so the panel learns AI is off
// before the user presses anything rather than after a failed explain.

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type ProvidersApi = ReturnType<typeof useAiProviders>;

function makeHarness(apiBase = "http://test") {
  const holder: { api: ProvidersApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useAiProviders({ apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

const TWO = {
  providers: [
    { id: "fast", name: "Fast", kind: "anthropic", model: "claude-sonnet-4-6", default: false },
    { id: "deep", name: "Deep", kind: "anthropic", model: "claude-opus-4-8", default: true },
  ],
};

describe("useAiProviders", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts idle, knowing nothing — it has not asked yet", () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.providers.value).toEqual([]);
    expect(holder.api!.selected.value).toBeUndefined();
    expect(holder.api!.isDisabled.value).toBe(false);
    wrapper.unmount();
  });

  it("load() GETs /ai/providers and keeps the server's order", async () => {
    mockFetch.mockResolvedValueOnce(TWO);
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load();
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/ai/providers");
    expect(holder.api!.providers.value.map((p) => p.id)).toEqual(["fast", "deep"]);
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  // Selecting the server's default rather than the first entry: the
  // panel's initial selection has to agree with what the server would
  // have chosen for a request that names nobody, or the first call
  // silently uses a different provider than the one shown.
  it("selects the provider the server marked default", async () => {
    mockFetch.mockResolvedValueOnce(TWO);
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load();
    await flushPromises();

    expect(holder.api!.selected.value).toBe("deep");
    wrapper.unmount();
  });

  it("falls back to the first entry when the server marks no default", async () => {
    mockFetch.mockResolvedValueOnce({
      providers: [
        { id: "only", name: "Only", kind: "anthropic", model: "m", default: false },
        { id: "other", name: "Other", kind: "anthropic", model: "m", default: false },
      ],
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load();
    await flushPromises();

    expect(holder.api!.selected.value).toBe("only");
    wrapper.unmount();
  });

  it("treats a 404 ai_disabled as 'this deployment has no AI', not as an error to show", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "ai_disabled", message: "AI provider is not configured" } },
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load();
    await flushPromises();

    expect(holder.api!.isDisabled.value).toBe(true);
    expect(holder.api!.providers.value).toEqual([]);
    expect(holder.api!.selected.value).toBeUndefined();
    // Not "error": a deployment without AI is a configuration, and the
    // panel renders a neutral notice for it rather than a red banner.
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("surfaces any other failure as an error, because that one is worth retrying", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load();
    await flushPromises();

    expect(holder.api!.state.value).toBe("error");
    expect(holder.api!.lastError.value).not.toBeNull();
    expect(holder.api!.isDisabled.value).toBe(false);
    wrapper.unmount();
  });

  it("lets the caller choose another configured provider", async () => {
    mockFetch.mockResolvedValueOnce(TWO);
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load();
    await flushPromises();
    holder.api!.select("fast");

    expect(holder.api!.selected.value).toBe("fast");
    wrapper.unmount();
  });

  // The server answers 422 for a name it does not have, so a selection
  // the panel invented would turn into a failed call. Refusing it here
  // keeps the selector unable to describe a state the server rejects.
  it("ignores a selection that is not one of the configured providers", async () => {
    mockFetch.mockResolvedValueOnce(TWO);
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load();
    await flushPromises();
    holder.api!.select("gpt-4o");

    expect(holder.api!.selected.value).toBe("deep");
    wrapper.unmount();
  });
});
