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
});
