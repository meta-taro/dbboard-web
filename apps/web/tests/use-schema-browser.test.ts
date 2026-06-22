import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useSchemaBrowser } from "../app/composables/useSchemaBrowser";

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type SchemaApi = ReturnType<typeof useSchemaBrowser>;

function makeHarness(connectionId: string, apiBase = "http://test") {
  const holder: { api: SchemaApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useSchemaBrowser(connectionId, { apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

describe("useSchemaBrowser", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches /connections/:id/tables on mount", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/abc/tables");
    expect(holder.api!.tables.value).toEqual([]);
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("stores the fetched table list verbatim", async () => {
    mockFetch.mockResolvedValueOnce({
      tables: [
        { schema: "public", name: "users" },
        { schema: null, name: "kv" },
      ],
    });
    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.tables.value).toEqual([
      { schema: "public", name: "users" },
      { schema: null, name: "kv" },
    ]);
    wrapper.unmount();
  });

  it("surfaces a categorised error when the fetch rejects", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.state.value).toBe("error");
    expect(holder.api!.lastError.value?.category).toBe("connection");
    expect(holder.api!.lastError.value?.i18nKey).toBe("error.prefix.connection");
    wrapper.unmount();
  });

  it("refresh() re-fetches and replaces the list", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "first" }] });
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "second" }] });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    expect(holder.api!.tables.value.map((t) => t.name)).toEqual(["first"]);

    await holder.api!.refresh();
    expect(holder.api!.tables.value.map((t) => t.name)).toEqual(["second"]);
    wrapper.unmount();
  });

  it('loadColumns(schema, table) posts a SELECT * FROM "schema"."table" LIMIT 0 and returns columns', async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "users" }] });
    mockFetch.mockResolvedValueOnce({
      columns: [
        { name: "id", declared_type: "INTEGER" },
        { name: "email", declared_type: "TEXT" },
      ],
      rows: [],
      rows_affected: 0,
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    const columns = await holder.api!.loadColumns("public", "users");
    expect(columns).toEqual([
      { name: "id", declared_type: "INTEGER" },
      { name: "email", declared_type: "TEXT" },
    ]);
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: 'SELECT * FROM "public"."users" LIMIT 0' },
    });
    wrapper.unmount();
  });

  it("loadColumns(null, table) omits the schema qualifier", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: null, name: "kv" }] });
    mockFetch.mockResolvedValueOnce({
      columns: [{ name: "k", declared_type: "TEXT" }],
      rows: [],
      rows_affected: 0,
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.loadColumns(null, "kv");
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: 'SELECT * FROM "kv" LIMIT 0' },
    });
    wrapper.unmount();
  });

  it("escapes embedded double-quotes by doubling per the SQL standard", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce({
      columns: [],
      rows: [],
      rows_affected: 0,
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.loadColumns('weird"schema', 'weird"table');
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: 'SELECT * FROM "weird""schema"."weird""table" LIMIT 0' },
    });
    wrapper.unmount();
  });

  it("clears lastError on a successful refresh after a failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: null, name: "ok" }] });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    expect(holder.api!.lastError.value).not.toBeNull();

    await holder.api!.refresh();
    expect(holder.api!.lastError.value).toBeNull();
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });
});
