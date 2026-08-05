import { flushPromises, mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useRowUpdate } from "../app/composables/useRowUpdate";
import type { RowUpdate } from "../app/utils/grid-edit";

// Ticket 0028 slice E — the client half of `POST /connections/:id/rows`.
// The loop lives here rather than in ResultGrid.vue for one reason: the
// rules it enforces (one request per touched row, stop at the first
// failure, keep the staged edits) are testable without mounting a grid,
// and they are the rules a user notices when they are wrong.

vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type RowUpdateApi = ReturnType<typeof useRowUpdate>;

function makeHarness(apiBase = "http://test") {
  const holder: { api: RowUpdateApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useRowUpdate({ apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

const TABLE = { schema: "public", name: "users" };

function update(id: number, email: string): RowUpdate {
  return {
    key: [{ column: "id", value: id }],
    edits: [{ column: "email", value: email }],
  };
}

describe("useRowUpdate", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("starts idle with no error", () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    expect(holder.api!.saving.value).toBe(false);
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("POSTs one request per update, to that connection's rows route", async () => {
    mockFetch.mockResolvedValue({ rows_affected: 1 });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const ok = await holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x"), update(2, "b@x")]);
    await flushPromises();

    expect(ok).toBe(true);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockFetch).toHaveBeenNthCalledWith(1, "http://test/connections/c1/rows", {
      method: "POST",
      body: {
        table: "users",
        schema: "public",
        key: [{ column: "id", value: 1 }],
        edits: [{ column: "email", value: "a@x" }],
      },
    });
    wrapper.unmount();
  });

  it("omits `schema` entirely when the table has none", async () => {
    // Absent means "the engine's default", and the DTO rejects an empty
    // string — sending one would turn a default into a 422.
    mockFetch.mockResolvedValue({ rows_affected: 1 });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.applyUpdates("c1", { schema: null, name: "notes" }, [update(1, "x")]);
    await flushPromises();

    const body = mockFetch.mock.calls[0]![1]!.body as Record<string, unknown>;
    expect("schema" in body).toBe(false);
    wrapper.unmount();
  });

  it("carries an explicit NULL through as null, distinct from empty text", async () => {
    mockFetch.mockResolvedValue({ rows_affected: 1 });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.applyUpdates("c1", TABLE, [
      { key: [{ column: "id", value: 1 }], edits: [{ column: "email", value: null }] },
    ]);
    await flushPromises();

    const body = mockFetch.mock.calls[0]![1]!.body as { edits: Array<{ value: unknown }> };
    expect(body.edits[0]!.value).toBeNull();
    wrapper.unmount();
  });

  it("holds `saving` while the requests are in flight and drops it after", async () => {
    let release!: (value: { rows_affected: number }) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<{ rows_affected: number }>((resolve) => {
        release = resolve;
      }),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const pending = holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x")]);
    await flushPromises();
    expect(holder.api!.saving.value).toBe(true);

    release({ rows_affected: 1 });
    await pending;
    expect(holder.api!.saving.value).toBe(false);
    wrapper.unmount();
  });

  it("stops at the first failure rather than writing the rest of the rows", async () => {
    // Half a save is worse than none the user can retry: the rows past the
    // failure are still staged, so stopping keeps the grid honest about
    // what has been written.
    mockFetch.mockRejectedValueOnce(new Error("nope"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const ok = await holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x"), update(2, "b@x")]);

    expect(ok).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("reports the failure as a categorised error the banner can prefix", async () => {
    mockFetch.mockRejectedValueOnce({
      data: { error: { category: "query", message: "no row matched" } },
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x")]);

    expect(holder.api!.lastError.value).toEqual({
      category: "query",
      message: "no row matched",
      i18nKey: "error.prefix.query",
    });
    expect(holder.api!.saving.value).toBe(false);
    wrapper.unmount();
  });

  it("clears a previous error when the next save succeeds", async () => {
    mockFetch.mockRejectedValueOnce(new Error("nope"));
    mockFetch.mockResolvedValueOnce({ rows_affected: 1 });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x")]);
    expect(holder.api!.lastError.value).not.toBeNull();

    await holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x")]);
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("refuses to run a second save while one is in flight", async () => {
    // Save is a button the user can double-click, and each request is a
    // write. The second click must not duplicate the first.
    let release!: (value: { rows_affected: number }) => void;
    mockFetch.mockReturnValueOnce(
      new Promise<{ rows_affected: number }>((resolve) => {
        release = resolve;
      }),
    );
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    const first = holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x")]);
    await flushPromises();
    const second = await holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x")]);

    expect(second).toBe(false);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    release({ rows_affected: 1 });
    await first;
    wrapper.unmount();
  });

  it("forgets the last error on request, for a caller that discarded the edits", async () => {
    // The grid's Discard button: with nothing left staged, an error about a
    // write that will never be retried is just a red box nobody can clear.
    mockFetch.mockRejectedValueOnce(new Error("nope"));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.applyUpdates("c1", TABLE, [update(1, "a@x")]);
    expect(holder.api!.lastError.value).not.toBeNull();

    holder.api!.reset();

    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("does nothing, successfully, when there is nothing to write", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(await holder.api!.applyUpdates("c1", TABLE, [])).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    wrapper.unmount();
  });
});
