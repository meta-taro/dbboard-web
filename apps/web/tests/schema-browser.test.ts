import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../app/composables/internal/http";
import SchemaBrowser from "../app/components/SchemaBrowser.vue";

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

const mountOptions = { props: { connectionId: "abc", apiBase: "http://test" } };

// The composable probes capabilities before its first column fetch. Most of
// these tests exercise the shallow LIMIT 0 path, so they answer "no".
const CANNOT_DESCRIBE = { id: "null", capabilities: { has_describe_table: false } };

describe("SchemaBrowser", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the panel with the schema-browser testid", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='schema-browser']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("renders the empty-state copy when /tables returns []", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [] });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    expect(wrapper.text()).toContain("schema.empty");
    expect(wrapper.findAll("[data-testid='schema-group']")).toHaveLength(0);
    wrapper.unmount();
  });

  it("groups tables by schema and folds null schemas under the default group", async () => {
    mockFetch.mockResolvedValueOnce({
      tables: [
        { schema: "public", name: "users" },
        { schema: null, name: "kv" },
        { schema: "public", name: "accounts" },
      ],
    });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    const groups = wrapper.findAll("[data-testid='schema-group']");
    expect(groups).toHaveLength(2);
    const headers = groups.map((g) => g.find("summary").text());
    expect(headers.some((h) => h.includes("public"))).toBe(true);
    expect(headers.some((h) => h.includes("schema.default-schema"))).toBe(true);
    wrapper.unmount();
  });

  it("emits insert with the quoted schema.table when a table insert button is clicked", async () => {
    mockFetch.mockResolvedValueOnce({
      tables: [{ schema: "public", name: "users" }],
    });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='schema-insert-table']").trigger("click");
    const emitted = wrapper.emitted("insert");
    expect(emitted).toBeDefined();
    expect(emitted![0]).toEqual(['"public"."users"']);
    wrapper.unmount();
  });

  it('emits insert with the quoted "table" when the schema is null', async () => {
    mockFetch.mockResolvedValueOnce({
      tables: [{ schema: null, name: "kv" }],
    });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='schema-insert-table']").trigger("click");
    const emitted = wrapper.emitted("insert");
    expect(emitted![0]).toEqual(['"kv"']);
    wrapper.unmount();
  });

  // Browse is the schema browser's second verb (ticket 0028 slice A). Insert
  // hands the user a name to write SQL around; browse hands them a whole
  // statement and the provenance the cell editor keys editability on.
  it("emits browse with a bounded SELECT * and the source table", async () => {
    mockFetch.mockResolvedValueOnce({
      tables: [{ schema: "public", name: "users" }],
    });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='schema-browse-table']").trigger("click");
    const emitted = wrapper.emitted("browse");
    expect(emitted).toBeDefined();
    expect(emitted![0]).toEqual([
      {
        sql: 'SELECT * FROM "public"."users" LIMIT 100;',
        table: { schema: "public", name: "users" },
      },
    ]);
    wrapper.unmount();
  });

  it("carries the table through browse unqualified when the schema is null", async () => {
    mockFetch.mockResolvedValueOnce({
      tables: [{ schema: null, name: "kv" }],
    });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='schema-browse-table']").trigger("click");
    const emitted = wrapper.emitted("browse");
    expect(emitted![0]).toEqual([
      { sql: 'SELECT * FROM "kv" LIMIT 100;', table: { schema: null, name: "kv" } },
    ]);
    wrapper.unmount();
  });

  it("does not expand the table when browse is clicked", async () => {
    // The button sits inside the <summary>, so a bare click would toggle the
    // <details> and fire an unwanted column probe on top of the browse.
    mockFetch.mockResolvedValueOnce({
      tables: [{ schema: "public", name: "users" }],
    });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await wrapper.find("[data-testid='schema-browse-table']").trigger("click");
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("lazy-loads columns on first table expand and caches the result on the second expand", async () => {
    mockFetch.mockResolvedValueOnce({
      tables: [{ schema: "public", name: "users" }],
    });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockResolvedValueOnce({
      columns: [
        { name: "id", declared_type: "INTEGER" },
        { name: "email", declared_type: "TEXT" },
      ],
      rows: [],
      rows_affected: 0,
    });

    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const tableDetails = wrapper.find("[data-testid='schema-table']");
    await tableDetails.trigger("toggle");
    await flushPromises();

    // Probe + columns.
    expect(mockFetch).toHaveBeenCalledTimes(3);
    const columnRows = wrapper.findAll("[data-testid='schema-column']");
    expect(columnRows).toHaveLength(2);
    expect(columnRows[0]!.text()).toContain("id");
    expect(columnRows[1]!.text()).toContain("email");

    // Re-toggle — cache hit, no further fetches.
    await tableDetails.trigger("toggle");
    await tableDetails.trigger("toggle");
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(3);

    wrapper.unmount();
  });

  it("emits insert with the quoted column name (no schema/table prefix) on column-button click", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "users" }] });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockResolvedValueOnce({
      columns: [{ name: "email", declared_type: "TEXT" }],
      rows: [],
      rows_affected: 0,
    });

    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();
    await wrapper.find("[data-testid='schema-table']").trigger("toggle");
    await flushPromises();

    await wrapper.find("[data-testid='schema-insert-column']").trigger("click");
    const emitted = wrapper.emitted("insert");
    expect(emitted).toBeDefined();
    expect(emitted![0]).toEqual(['"email"']);
    wrapper.unmount();
  });

  it("refresh button re-fetches /tables", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "old" }] });
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "new" }] });

    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await wrapper.find("[data-testid='schema-refresh']").trigger("click");
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(wrapper.text()).toContain("new");
    wrapper.unmount();
  });

  it("renders the global error banner when /tables fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='schema-error']").exists()).toBe(true);
    expect(wrapper.text()).toContain("schema.error.load");
    // The searchable half (desktop ADR-0039). `t` is stubbed to echo the key
    // here, so the English can only have come from the en bundle.
    expect(wrapper.find("[data-testid='error-banner__original']").text()).toBe(
      "Failed to load schema: Network down",
    );
    wrapper.unmount();
  });

  it("renders the column-load error banner when LIMIT 0 fails", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "users" }] });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockRejectedValueOnce(new Error("permission denied"));

    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='schema-table']").trigger("toggle");
    await flushPromises();

    expect(wrapper.find("[data-testid='schema-columns-error']").exists()).toBe(true);
    expect(wrapper.text()).toContain("schema.error.columns");
    // Nothing from underneath, so no trailing colon on either half.
    expect(wrapper.find("[data-testid='error-banner__original']").text()).toBe(
      "Failed to load columns",
    );
    wrapper.unmount();
  });

  // ---- describe-route depth (0026) -----------------------------------

  const CAN_DESCRIBE = { id: "postgres", capabilities: { has_describe_table: true } };

  async function expandDescribed(columns: unknown[]) {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "users" }] });
    mockFetch.mockResolvedValueOnce(CAN_DESCRIBE);
    mockFetch.mockResolvedValueOnce({
      table: { schema: "public", name: "users" },
      columns,
      primary_key: ["id"],
    });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();
    await wrapper.find("[data-testid='schema-table']").trigger("toggle");
    await flushPromises();
    return wrapper;
  }

  it("marks a primary-key column and its NOT NULL constraint", async () => {
    const wrapper = await expandDescribed([
      {
        name: "id",
        declared_type: "integer",
        nullable: false,
        primary_key: true,
        ordinal: 1,
        default_value: null,
      },
      {
        name: "email",
        declared_type: "text",
        nullable: true,
        primary_key: false,
        ordinal: 2,
        default_value: null,
      },
    ]);

    const rows = wrapper.findAll("[data-testid='schema-column']");
    expect(rows[0]!.find("[data-testid='schema-column-pk']").exists()).toBe(true);
    expect(rows[0]!.find("[data-testid='schema-column-not-null']").exists()).toBe(true);
    // A nullable non-key column carries neither badge.
    expect(rows[1]!.find("[data-testid='schema-column-pk']").exists()).toBe(false);
    expect(rows[1]!.find("[data-testid='schema-column-not-null']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the default expression verbatim, unparsed", async () => {
    const wrapper = await expandDescribed([
      {
        name: "created_at",
        declared_type: "timestamp with time zone",
        nullable: false,
        primary_key: false,
        ordinal: 1,
        default_value: "now()",
      },
    ]);

    const shown = wrapper.find("[data-testid='schema-column-default']");
    expect(shown.exists()).toBe(true);
    expect(shown.text()).toContain("now()");
    wrapper.unmount();
  });

  // The shallow path knows none of this. Rendering "nullable" or "no
  // primary key" from its silence would be inventing an answer.
  it("renders no badges at all on the shallow LIMIT 0 path", async () => {
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "users" }] });
    mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
    mockFetch.mockResolvedValueOnce({
      columns: [{ name: "id", declared_type: "INTEGER" }],
      rows: [],
      rows_affected: 0,
    });

    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();
    await wrapper.find("[data-testid='schema-table']").trigger("toggle");
    await flushPromises();

    const row = wrapper.find("[data-testid='schema-column']");
    expect(row.text()).toContain("id");
    expect(row.find("[data-testid='schema-column-pk']").exists()).toBe(false);
    expect(row.find("[data-testid='schema-column-not-null']").exists()).toBe(false);
    expect(row.find("[data-testid='schema-column-default']").exists()).toBe(false);
    wrapper.unmount();
  });

  // ---- dialect seam (ADR-0072, rung 7 slice C) -------------------------
  //
  // Every identifier this panel emits is either handed to the editor or run
  // as SQL, and MySQL reads `"users"` as a string literal rather than a
  // table name. Getting this wrong is a syntax error in `FROM` and, in a
  // `SELECT` list, a column reference that silently becomes a constant.

  describe("mysql", () => {
    const mysqlOptions = {
      props: { connectionId: "abc", apiBase: "http://test", driver: "mysql" },
    };

    it("back-quotes the table name it inserts", async () => {
      mockFetch.mockResolvedValueOnce({ tables: [{ schema: "shop", name: "orders" }] });
      const wrapper = mount(SchemaBrowser, mysqlOptions);
      await flushPromises();

      await wrapper.find("[data-testid='schema-insert-table']").trigger("click");
      expect(wrapper.emitted("insert")![0]).toEqual(["`shop`.`orders`"]);
      wrapper.unmount();
    });

    it("back-quotes the browse statement", async () => {
      mockFetch.mockResolvedValueOnce({ tables: [{ schema: "shop", name: "orders" }] });
      const wrapper = mount(SchemaBrowser, mysqlOptions);
      await flushPromises();

      await wrapper.find("[data-testid='schema-browse-table']").trigger("click");
      expect(wrapper.emitted("browse")![0]).toEqual([
        {
          sql: "SELECT * FROM `shop`.`orders` LIMIT 100;",
          table: { schema: "shop", name: "orders" },
        },
      ]);
      wrapper.unmount();
    });

    it("back-quotes the column name it inserts", async () => {
      mockFetch.mockResolvedValueOnce({ tables: [{ schema: "shop", name: "orders" }] });
      mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
      mockFetch.mockResolvedValueOnce({
        columns: [{ name: "total", declared_type: "DECIMAL" }],
        rows: [],
        rows_affected: 0,
      });

      const wrapper = mount(SchemaBrowser, mysqlOptions);
      await flushPromises();
      await wrapper.find("[data-testid='schema-table']").trigger("toggle");
      await flushPromises();

      await wrapper.find("[data-testid='schema-insert-column']").trigger("click");
      expect(wrapper.emitted("insert")![0]).toEqual(["`total`"]);
      wrapper.unmount();
    });

    it("passes the driver down so the LIMIT 0 probe back-quotes too", async () => {
      // Reachable even though MySQL advertises `has_describe_table`: the
      // capability probe degrades to `false` when it cannot be answered,
      // and then the shallow path is the only one left.
      mockFetch.mockResolvedValueOnce({ tables: [{ schema: "shop", name: "orders" }] });
      mockFetch.mockResolvedValueOnce(CANNOT_DESCRIBE);
      mockFetch.mockResolvedValueOnce({ columns: [], rows: [], rows_affected: 0 });

      const wrapper = mount(SchemaBrowser, mysqlOptions);
      await flushPromises();
      await wrapper.find("[data-testid='schema-table']").trigger("toggle");
      await flushPromises();

      expect(mockFetch).toHaveBeenNthCalledWith(3, "http://test/connections/abc/query", {
        method: "POST",
        body: { sql: "SELECT * FROM `shop`.`orders` LIMIT 0" },
      });
      wrapper.unmount();
    });
  });

  it("stays ANSI when the driver prop is absent", async () => {
    // The page mounts this before the connection list has arrived, so
    // `undefined` is a real state and it must not produce broken SQL for
    // the drivers that were working before the seam existed.
    mockFetch.mockResolvedValueOnce({ tables: [{ schema: "public", name: "users" }] });
    const wrapper = mount(SchemaBrowser, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='schema-insert-table']").trigger("click");
    expect(wrapper.emitted("insert")![0]).toEqual(['"public"."users"']);
    wrapper.unmount();
  });
});
