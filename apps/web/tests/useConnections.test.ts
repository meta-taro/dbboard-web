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

  it("update(id, input) PATCHes the body and refreshes the list from the server", async () => {
    mockFetch.mockResolvedValueOnce({
      connections: [
        {
          id: "abc",
          label: "Prod",
          driver: "postgres",
          parts: { host: "old.host", port: 5432, user: "reader" },
        },
      ],
    });
    mockFetch.mockResolvedValueOnce({
      id: "abc",
      label: "Prod",
      driver: "postgres",
      parts: { host: "new.host", port: 5432, user: "reader" },
    });
    mockFetch.mockResolvedValueOnce({
      connections: [
        {
          id: "abc",
          label: "Prod",
          driver: "postgres",
          parts: { host: "new.host", port: 5432, user: "reader" },
        },
      ],
    });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    // The blank password is the case that matters: the server reads it as
    // "keep the one you have" (ADR-0080), so the composable must send it
    // rather than treat it as nothing to say.
    await api.update("abc", { host: "new.host", port: 5432, user: "reader", password: "" });

    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://test/connections/abc", {
      method: "PATCH",
      body: { host: "new.host", port: 5432, user: "reader", password: "" },
    });
    // Re-read rather than trusting the PATCH response: the list is what the
    // page renders, and the server is the only thing that knows what the
    // record became.
    expect(api.list.value).toEqual([
      {
        id: "abc",
        label: "Prod",
        driver: "postgres",
        parts: { host: "new.host", port: 5432, user: "reader" },
      },
    ]);
    expect(api.state.value).toBe("idle");
    wrapper.unmount();
  });

  it("register() sends an ssh block as its own member of the body", async () => {
    // 0031 slice F4. The block is nested rather than flattened into
    // `sshHost`/`sshUser`, because `SshTunnelDto` is validated with
    // `@ValidateNested()` and the global whitelist strips what it does not
    // know — flattened fields would vanish at the pipe and the connection
    // would be registered going direct.
    mockFetch.mockResolvedValueOnce({ connections: [] });
    mockFetch.mockResolvedValueOnce({ id: "abc" });
    mockFetch.mockResolvedValueOnce({ connections: [] });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.register({
      label: "Prod",
      driver: "postgres",
      host: "db.internal",
      ssh: { host: "bastion.example.com", user: "deploy", password: "pw", fingerprint: "SHA256:a" },
    });

    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://test/connections", {
      method: "POST",
      body: {
        label: "Prod",
        driver: "postgres",
        host: "db.internal",
        ssh: {
          host: "bastion.example.com",
          user: "deploy",
          password: "pw",
          fingerprint: "SHA256:a",
        },
      },
    });
    wrapper.unmount();
  });

  it("update() sends an explicit null to take a bastion away", async () => {
    // The state that has no other spelling (slice F2). Absent means "keep
    // the tunnel you are on", so a composable that dropped `null` on the way
    // past — as an empty-ish value, or by typing the field as optional-only
    // — would leave a connection permanently behind its bastion.
    mockFetch.mockResolvedValueOnce({ connections: [] });
    mockFetch.mockResolvedValueOnce({ id: "abc", label: "Prod", driver: "postgres" });
    mockFetch.mockResolvedValueOnce({ connections: [] });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.update("abc", { host: "db.internal", ssh: null });

    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://test/connections/abc", {
      method: "PATCH",
      body: { host: "db.internal", ssh: null },
    });
    wrapper.unmount();
  });

  it("update() leaves the list alone and reports the error when the edit is refused", async () => {
    const before = [{ id: "abc", label: "Prod", driver: "postgres" }];
    mockFetch.mockResolvedValueOnce({ connections: before });
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "connection", message: "ECONNREFUSED" } },
    });

    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await flushPromises();
    const api = holder.api!;

    await api.update("abc", { host: "unreachable" });

    expect(api.state.value).toBe("error");
    expect(api.lastError.value?.category).toBe("connection");
    // A refused edit changes nothing, so the row the user was editing is
    // still the row they were editing.
    expect(api.list.value).toEqual(before);
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
