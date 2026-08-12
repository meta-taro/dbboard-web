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

// v:2 `kind: "query"` — what the API actually writes since ticket 0023.
function recordLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 2,
    kind: "query",
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

// The v:1 shape, which desktop-emitted files still carry. No `kind`.
function v1RecordLine(overrides: Record<string, unknown> = {}): string {
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

  // `responseType` is not decoration. ofetch picks a parser from the
  // response's own content-type, and its rule is: `application/json` and
  // `+json` suffixes parse as JSON, `text/*` and a short allow-list parse as
  // text, everything else becomes a Blob. `application/x-ndjson` — which is
  // what this endpoint correctly sends, and what the Accept header above
  // asks for — falls into "everything else", so without this option the
  // composable receives a Blob and `parseNdjson` dies on `text.split`. The
  // rest of this file mocks `apiFetch` and therefore cannot see that, which
  // is exactly how it reached a browser. Assert the option, not the parse.
  it("fetches /history/export.jsonl on mount as text with the NDJSON Accept header", async () => {
    mockFetch.mockResolvedValueOnce("");
    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(mockFetch).toHaveBeenCalledWith("http://test/history/export.jsonl", {
      headers: { Accept: "application/x-ndjson" },
      responseType: "text",
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

  it("drops lines whose v field is beyond 2 (forward-compat per ADR-0027)", async () => {
    const text = [
      recordLine({ sql: "current" }),
      recordLine({ v: 3, sql: "future", ts: "2026-06-20T11:00:00.000Z" }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce(text);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["current"]);
    wrapper.unmount();
  });

  // The reader trailed the writer here. `apps/api` started emitting
  // `v: 2, kind: "query"` on 2026-08-04 (ticket 0023) and this composable
  // kept rejecting anything that was not `v: 1`, so the sidebar silently
  // showed nothing — no error state, just an empty list, which is why it
  // survived to a browser. Assert the shape the API actually writes.
  it("accepts v:2 kind=query records, which is what the API writes", async () => {
    mockFetch.mockResolvedValueOnce(recordLine({ sql: "SELECT * FROM customers" }));

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["SELECT * FROM customers"]);
    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  // ADR-0027 / brief 0008 Acceptance §2: a v:1 record loads as the
  // equivalent v:2 `kind: "query"` record. `apps/api` upgrades on read;
  // the web reader has to agree or a desktop-emitted file reads as empty.
  it("upgrades v:1 records to the equivalent v:2 query record", async () => {
    mockFetch.mockResolvedValueOnce(v1RecordLine({ sql: "legacy" }));

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.history.value).toHaveLength(1);
    expect(holder.api!.history.value[0]).toMatchObject({ v: 2, kind: "query", sql: "legacy" });
    wrapper.unmount();
  });

  // This panel is the SQL history sidebar: it renders `sql`, a two-value
  // ok/error badge and a replay button. An AI record has no `sql`, can
  // carry `status: "cancelled"` and may have `conn: null`. Dropping it
  // here keeps the panel as designed rather than inventing UI for a
  // record kind it was not built to show.
  it("drops kind=ai records — the SQL sidebar has nothing to render for them", async () => {
    const text = [
      recordLine({ sql: "kept" }),
      JSON.stringify({
        v: 2,
        kind: "ai",
        ts: "2026-06-20T11:00:00.000Z",
        conn: "abc",
        actor: null,
        intent: "explain",
        prompt: "why is this slow",
        response: "because",
        status: "ok",
        duration_ms: 900,
        tokens_in: 10,
        tokens_out: 20,
        provider: "openai",
        model: "gpt-4",
        stop_reason: "stop",
        error: null,
      }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce(text);

    const { Component, holder } = makeHarness("abc");
    const wrapper = mount(Component);
    await flushPromises();

    expect(holder.api!.history.value.map((r) => r.sql)).toEqual(["kept"]);
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
