import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useConnections } from "../app/composables/useConnections";

// vi.mock is hoisted by Vitest to before all imports — the order in
// source code matches lint's import/first rule while runtime swaps the
// thin $fetch indirection so the composable test never touches the network.
vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type ConnectionsApi = ReturnType<typeof useConnections>;

function makeHarness(apiBase = "http://test") {
  const holder: { api: ConnectionsApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useConnections({ apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

describe("useConnections", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("loads the connection list on mount via GET /connections", async () => {
    mockFetch.mockResolvedValueOnce({
      connections: [
        { id: "abc", label: "Prod", driver: "postgres" },
        { id: "def", label: "Staging", driver: "postgres" },
      ],
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections");
    expect(api.list.value).toEqual([
      { id: "abc", label: "Prod", driver: "postgres" },
      { id: "def", label: "Staging", driver: "postgres" },
    ]);
    expect(api.state.value).toBe("idle");
    expect(api.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("register() POSTs the body and refreshes the list from the server", async () => {
    // Initial mount load → empty list.
    mockFetch.mockResolvedValueOnce({ connections: [] });
    // POST /connections → server-assigned id.
    mockFetch.mockResolvedValueOnce({ id: "srv-1" });
    // Follow-up GET /connections → one row.
    mockFetch.mockResolvedValueOnce({
      connections: [{ id: "srv-1", label: "Neon", driver: "postgres" }],
    });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.register({
      label: "Neon",
      driver: "postgres",
      connectionString: "postgres://localhost/db",
    });

    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://test/connections", {
      method: "POST",
      body: {
        label: "Neon",
        driver: "postgres",
        connectionString: "postgres://localhost/db",
      },
    });
    expect(api.list.value).toEqual([{ id: "srv-1", label: "Neon", driver: "postgres" }]);
    expect(api.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("remove(id) DELETEs the connection and refreshes the list", async () => {
    mockFetch.mockResolvedValueOnce({
      connections: [{ id: "abc", label: "Prod", driver: "postgres" }],
    });
    mockFetch.mockResolvedValueOnce(null);
    mockFetch.mockResolvedValueOnce({ connections: [] });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.remove("abc");

    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://test/connections/abc", {
      method: "DELETE",
    });
    expect(api.list.value).toEqual([]);
    expect(api.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("surfaces the categorised error envelope on lastError and flips state to 'error'", async () => {
    mockFetch.mockResolvedValueOnce({ connections: [] });
    mockFetch.mockRejectedValueOnce({
      data: {
        error: { category: "connection", message: "ECONNREFUSED" },
      },
    });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.register({
      label: "Broken",
      driver: "postgres",
      connectionString: "postgres://nowhere:5/db",
    });

    expect(api.state.value).toBe("error");
    expect(api.lastError.value).toEqual({
      category: "connection",
      message: "ECONNREFUSED",
      i18nKey: "error.prefix.connection",
    });
    wrapper.unmount();
  });

  it("normalises 'type_conversion' (backend underscore) to the hyphenated i18n key", async () => {
    mockFetch.mockResolvedValueOnce({ connections: [] });
    mockFetch.mockRejectedValueOnce({
      data: {
        error: { category: "type_conversion", message: "cannot convert NaN" },
      },
    });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.register({ label: "x", driver: "postgres" });

    expect(api.lastError.value?.i18nKey).toBe("error.prefix.type-conversion");
    expect(api.lastError.value?.category).toBe("type_conversion");
    wrapper.unmount();
  });

  it("falls back to category='connection' when the envelope is unparseable", async () => {
    mockFetch.mockResolvedValueOnce({ connections: [] });
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.register({ label: "x", driver: "postgres" });

    expect(api.state.value).toBe("error");
    expect(api.lastError.value?.category).toBe("connection");
    expect(api.lastError.value?.i18nKey).toBe("error.prefix.connection");
    expect(api.lastError.value?.message).toContain("Network down");
    wrapper.unmount();
  });
});
