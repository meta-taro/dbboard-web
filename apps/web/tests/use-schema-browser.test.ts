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

function makeHarness(connectionId: string, apiBase = "http://test", driver?: string) {
  const holder: { api: SchemaApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useSchemaBrowser(connectionId, { apiBase, driver });
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
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
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
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
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
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
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

  it("back-quotes the LIMIT 0 probe for a mysql connection", async () => {
    // Reachable despite MySQL advertising `has_describe_table`: the
    // capability probe degrades to `false` when it cannot be answered, and
    // then this is the only path left. An ANSI-quoted probe would fail
    // there with a syntax error and the sidebar would report the table as
    // having no columns it could read.
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "shop", name: "orders" }] });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockResolvedValueOnce({ columns: [], rows: [], rows_affected: 0 });

    const { Component, holder } = makeHarness("abc", "http://test", "mysql");
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.loadColumns("shop", "orders");
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: "SELECT * FROM `shop`.`orders` LIMIT 0" },
    });
    wrapper.unmount();
  });

  it("keeps ANSI quoting when no driver was supplied", async () => {
    // The page renders the sidebar before the connection list has arrived,
    // so `undefined` is a state the composable is really constructed in.
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockResolvedValueOnce({ columns: [], rows: [], rows_affected: 0 });

    const { Component, holder } = makeHarness("abc", "http://test", undefined);
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.loadColumns(null, "orders");
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: 'SELECT * FROM "orders" LIMIT 0' },
    });
    wrapper.unmount();
  });

  it("reads a driver that only arrives after mount", async () => {
    // The page learns the driver from an in-flight `GET /connections`, which
    // resolves after this composable is constructed. Reading the option once
    // at setup would pin ANSI for the whole session and quietly break every
    // MySQL sidebar whose connection list was a tick slower than the page.
    let driver: string | undefined = undefined;
    const holder: { api: SchemaApi | null } = { api: null };
    const Component = defineComponent({
      setup() {
        holder.api = useSchemaBrowser("abc", {
          apiBase: "http://test",
          driver: () => driver,
        });
        return () => h("div");
      },
    });

    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockResolvedValueOnce({ columns: [], rows: [], rows_affected: 0 });

    const wrapper = mount(Component);
    await flushPromises();
    driver = "mysql";

    await holder.api!.loadColumns("shop", "orders");
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: "SELECT * FROM `shop`.`orders` LIMIT 0" },
    });
    wrapper.unmount();
  });

  // ---- describe route (0026) ----------------------------------------

  const CAN_DESCRIBE = { id: "postgres", capabilities: { has_describe_table: true } };
  const CANNOT_DESCRIBE = { id: "null", capabilities: { has_describe_table: false } };

  const USERS_SCHEMA = {
    table: { schema: "public", name: "users" },
    columns: [
      {
        name: "id",
        declared_type: "integer",
        nullable: false,
        primary_key: true,
        ordinal: 1,
        default_value: "nextval('users_id_seq'::regclass)",
      },
      {
        name: "email",
        declared_type: "text",
        nullable: true,
        primary_key: false,
        ordinal: 2,
        default_value: null,
      },
    ],
    primary_key: ["id"],
  };

  it("uses the describe route, with its extra depth, when the connection advertises it", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "users" }] });
    mockFetch.mockResolvedValueOnce(CAN_DESCRIBE);
    mockFetch.mockResolvedValueOnce(USERS_SCHEMA);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    const columns = await holder.api!.loadColumns("public", "users");
    expect(mockFetch).toHaveBeenNthCalledWith(2, "http://test/connections/abc/capabilities");
    expect(mockFetch).toHaveBeenNthCalledWith(
      3,
      "http://test/connections/abc/table-schema?table=users&schema=public",
    );
    expect(columns).toEqual(USERS_SCHEMA.columns);
    wrapper.unmount();
  });

  it("omits ?schema= when the table has none — the adapter picks the default", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce(CAN_DESCRIBE);
    mockFetch.mockResolvedValueOnce({
      table: { schema: null, name: "kv" },
      columns: [],
      primary_key: [],
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.loadColumns(null, "kv");
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/table-schema?table=kv");
    wrapper.unmount();
  });

  // The route takes identifiers as query parameters precisely so these
  // survive; the client's half of that bargain is encoding them.
  it("percent-encodes identifiers that would otherwise break the URL", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce(CAN_DESCRIBE);
    mockFetch.mockResolvedValueOnce({
      table: { schema: null, name: "x" },
      columns: [],
      primary_key: [],
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.loadColumns("we/ird", 'a&b?c#d"e');
    const url = mockFetch.mock.calls.at(-1)![0] as string;
    expect(url).toBe(
      "http://test/connections/abc/table-schema?table=a%26b%3Fc%23d%22e&schema=we%2Fird",
    );
    wrapper.unmount();
  });

  it("probes capabilities once and reuses the answer for every table", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce(CAN_DESCRIBE);
    mockFetch.mockResolvedValue({
      table: { schema: null, name: "x" },
      columns: [],
      primary_key: [],
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    await holder.api!.loadColumns(null, "one");
    await holder.api!.loadColumns(null, "two");

    const probes = mockFetch.mock.calls.filter(([url]) =>
      String(url).endsWith("/connections/abc/capabilities"),
    );
    expect(probes).toHaveLength(1);
    wrapper.unmount();
  });

  it("falls back to LIMIT 0 when the connection cannot describe", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockResolvedValueOnce({
      columns: [{ name: "k", declared_type: "TEXT" }],
      rows: [],
      rows_affected: 0,
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    const columns = await holder.api!.loadColumns(null, "kv");
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: 'SELECT * FROM "kv" LIMIT 0' },
    });
    expect(columns).toEqual([{ name: "k", declared_type: "TEXT" }]);
    wrapper.unmount();
  });

  // An unreachable probe is not a reason to show the user nothing: the
  // shallow path still works, so degrade to it rather than fail.
  it("falls back to LIMIT 0 when the probe itself fails", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockRejectedValueOnce(new Error("probe exploded"));
    mockFetch.mockResolvedValueOnce({
      columns: [{ name: "k", declared_type: "TEXT" }],
      rows: [],
      rows_affected: 0,
    });

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    const columns = await holder.api!.loadColumns(null, "kv");
    expect(mockFetch).toHaveBeenLastCalledWith("http://test/connections/abc/query", {
      method: "POST",
      body: { sql: 'SELECT * FROM "kv" LIMIT 0' },
    });
    expect(columns).toEqual([{ name: "k", declared_type: "TEXT" }]);
    wrapper.unmount();
  });

  // Once the route is chosen, its failure is the answer. Retrying through
  // LIMIT 0 would only turn a legible "relation does not exist" into a
  // second copy of the same failure.
  it("does not retry through LIMIT 0 when the describe route fails", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    mockFetch.mockResolvedValueOnce(CAN_DESCRIBE);
    mockFetch.mockRejectedValueOnce(new Error("relation does not exist"));

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    await expect(holder.api!.loadColumns(null, "ghost")).rejects.toThrow(/relation/);
    expect(mockFetch).toHaveBeenCalledTimes(3);
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
