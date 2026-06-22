import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h } from "vue";
import { apiFetch } from "../app/composables/internal/http";
import { useQueryHistory } from "../app/composables/useQueryHistory";

// Same indirection swap as useConnections.test.ts and
// useQueryExecution.test.ts — the composable goes through `apiFetch`
// so the test mocks the module and never reaches the network.
vi.mock("../app/composables/internal/http", () => ({
  apiFetch: vi.fn(),
}));

const mockFetch = vi.mocked(apiFetch);

type HistoryApi = ReturnType<typeof useQueryHistory>;

function makeHarness(connectionId: string, apiBase = "http://test") {
  const holder: { api: HistoryApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useQueryHistory(connectionId, { apiBase });
      return () => h("div");
    },
  });
  return { Component, holder };
}

function recordLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    ts: "2026-06-20T10:00:00.000Z",
    conn: "abc",
    actor: null,
    sql: "SELECT 1",
    status: "ok",
    duration_ms: 5,
    rows: 1,
    rows_affected: null,
    error: null,
    ...overrides,
  });
}

describe("useQueryHistory", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fetches /history/export.jsonl on mount with the NDJSON Accept header", async () => {
    mockFetch.mockResolvedValueOnce("");
    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/history/export.jsonl", {
      headers: { Accept: "application/x-ndjson" },
    });
    expect(holder.api!.history.value).toEqual([]);
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastError.value).toBeNull();
    wrapper.unmount();
  });

  it("filters records to the matching connection and sorts newest-first by ts", async () => {
    const text = [
      recordLine({ ts: "2026-06-20T10:00:00.000Z", conn: "abc", sql: "first" }),
      recordLine({ ts: "2026-06-20T11:00:00.000Z", conn: "other", sql: "ignored" }),
      recordLine({ ts: "2026-06-20T12:00:00.000Z", conn: "abc", sql: "second" }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce(text);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["second", "first"]);
    wrapper.unmount();
  });

  it("drops lines whose v field is not 1 (forward-compat per ADR-0017)", async () => {
    const text = [
      recordLine({ sql: "current" }),
      recordLine({ v: 2, sql: "future", ts: "2026-06-20T11:00:00.000Z" }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce(text);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["current"]);
    wrapper.unmount();
  });

  it("drops malformed JSON lines silently without surfacing an error", async () => {
    const text = [
      recordLine({ sql: "good", ts: "2026-06-20T10:00:00.000Z" }),
      "not json",
      recordLine({ sql: "also good", ts: "2026-06-20T11:00:00.000Z" }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce(text);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["also good", "good"]);
    expect(holder.api!.state.value).toBe("idle");
    expect(holder.api!.lastError.value).toBeNull();
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
    expect(holder.api!.lastError.value?.message).toContain("Network down");
    wrapper.unmount();
  });

  it("refresh() re-fetches and replaces the list", async () => {
    mockFetch.mockResolvedValueOnce(recordLine({ sql: "first" }));
    mockFetch.mockResolvedValueOnce(recordLine({ sql: "second", ts: "2026-06-21T10:00:00.000Z" }));

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();
    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["first"]);

    await holder.api!.refresh();
    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["second"]);
    wrapper.unmount();
  });

  it("clears lastError on a successful refresh after a failure", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));
    mockFetch.mockResolvedValueOnce(recordLine({ sql: "recovered" }));

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
