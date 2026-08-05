import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useEditContext } from "../app/composables/useEditContext";

// Ticket 0028 slice E — the page half of inline editing.
//
// `ResultGrid` is handed an `EditContext` or nothing, and that decision is
// made here. Two rules it exists to hold:
//
// - **Provenance, never SQL.** Only a browse names a table; arbitrary SQL
//   arrives as `null` and stays read-only. Nothing here parses a query.
// - **"No primary key" and "we could not ask" are different answers.** Both
//   leave the grid read-only, but only the first is something we can tell
//   the user. A describe that failed means unknown, and unknown says
//   nothing.

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type EditContextApi = ReturnType<typeof useEditContext>;

function makeHarness(connectionId = "c1", apiBase = "http://test") {
  const holder: { api: EditContextApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useEditContext(connectionId, { apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

const USERS = { schema: "public", name: "users" };

function schemaResponse(primaryKey: string[]) {
  return {
    table: "users",
    columns: [{ name: "id", declared_type: "INTEGER" }],
    primary_key: primaryKey,
  };
}

describe("useEditContext", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("holds no context until a browse names a table", () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(holder.api!.context.value).toBeNull();
    expect(holder.api!.noPk.value).toBe(false);
    expect(mockFetch).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("reads the table's schema and offers a context keyed on its primary key", async () => {
    mockFetch.mockResolvedValue(schemaResponse(["id"]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load(USERS);

    expect(mockFetch).toHaveBeenCalledWith(
      "http://test/connections/c1/table-schema?table=users&schema=public",
    );
    expect(holder.api!.context.value).toEqual({
      connectionId: "c1",
      table: USERS,
      pk: ["id"],
    });
    expect(holder.api!.noPk.value).toBe(false);
    wrapper.unmount();
  });

  it("carries every column of a composite key, in the order the server gave", async () => {
    mockFetch.mockResolvedValue(schemaResponse(["tenant_id", "id"]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load(USERS);

    expect(holder.api!.context.value!.pk).toEqual(["tenant_id", "id"]);
    wrapper.unmount();
  });

  it("omits `schema` from the query when the table has none", async () => {
    // Same reason the write route omits it: absent means "the engine's
    // default", and an empty string is a different, wrong request.
    mockFetch.mockResolvedValue(schemaResponse(["id"]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load({ schema: null, name: "notes" });

    expect(mockFetch).toHaveBeenCalledWith("http://test/connections/c1/table-schema?table=notes");
    wrapper.unmount();
  });

  it("refuses to edit a table with no declared primary key, and says why", async () => {
    mockFetch.mockResolvedValue(schemaResponse([]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load(USERS);

    expect(holder.api!.context.value).toBeNull();
    expect(holder.api!.noPk.value).toBe(true);
    wrapper.unmount();
  });

  it("stays read-only but claims nothing when the schema read fails", async () => {
    // A connection that cannot describe, or a describe that errored, has
    // told us nothing about keys. Rendering "this table has no primary key"
    // off that would be a confident lie.
    mockFetch.mockRejectedValue(new Error("unsupported"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load(USERS);

    expect(holder.api!.context.value).toBeNull();
    expect(holder.api!.noPk.value).toBe(false);
    wrapper.unmount();
  });

  it("drops the context the moment a non-browse query takes the grid", async () => {
    mockFetch.mockResolvedValue(schemaResponse(["id"]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load(USERS);
    expect(holder.api!.context.value).not.toBeNull();

    await holder.api!.load(null);

    expect(holder.api!.context.value).toBeNull();
    expect(holder.api!.noPk.value).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("clears the previous table's key before the new one's arrives", async () => {
    // The rows on screen change the instant the query resolves. A stale key
    // left in place for even one tick is a key belonging to another table.
    mockFetch.mockResolvedValueOnce(schemaResponse(["id"]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.load(USERS);

    mockFetch.mockReturnValueOnce(new Promise(() => {}));
    const pending = holder.api!.load({ schema: "public", name: "orders" });
    await flushPromises();

    expect(holder.api!.context.value).toBeNull();
    void pending;
    wrapper.unmount();
  });

  it("ignores the answer to a browse that has already been superseded", async () => {
    let releaseFirst!: (value: ReturnType<typeof schemaResponse>) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((resolve) => {
        releaseFirst = resolve;
      }),
    );
    mockFetch.mockResolvedValueOnce(schemaResponse(["order_id"]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const first = holder.api!.load(USERS);
    await holder.api!.load({ schema: "public", name: "orders" });

    releaseFirst(schemaResponse(["id"]));
    await first;
    await flushPromises();

    expect(holder.api!.context.value).toEqual({
      connectionId: "c1",
      table: { schema: "public", name: "orders" },
      pk: ["order_id"],
    });
    wrapper.unmount();
  });

  it("does not let a superseded failure clear the table that replaced it", async () => {
    let rejectFirst!: (reason: Error) => void;
    mockFetch.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFirst = reject;
      }),
    );
    mockFetch.mockResolvedValueOnce(schemaResponse([]));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const first = holder.api!.load(USERS);
    await holder.api!.load({ schema: "public", name: "logs" });

    rejectFirst(new Error("too late"));
    await first;
    await flushPromises();

    // The second browse's answer stands: it *did* describe, and found no key.
    expect(holder.api!.noPk.value).toBe(true);
    wrapper.unmount();
  });
});
