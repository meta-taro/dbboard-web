import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../app/composables/internal/http";
import HistorySidebar from "../app/components/HistorySidebar.vue";

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

// Same pattern as useConnections.test.ts: pass apiBase as a prop and the
// composable never touches useRuntimeConfig, so the happy-dom run does
// not need a Nuxt instance.

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

const mountOptions = { props: { connectionId: "abc", apiBase: "http://test" } };

describe("HistorySidebar", () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("mounts the sidebar with the history-sidebar testid", async () => {
    mockFetch.mockResolvedValueOnce("");
    const wrapper = mount(HistorySidebar, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='history-sidebar']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("shows the empty-state copy when no records match the connection", async () => {
    mockFetch.mockResolvedValueOnce("");
    const wrapper = mount(HistorySidebar, mountOptions);
    await flushPromises();

    expect(wrapper.text()).toContain("history.empty");
    expect(wrapper.findAll("[data-testid='history-row']")).toHaveLength(0);
    wrapper.unmount();
  });

  it("renders one row per matching record with status badge and duration", async () => {
    const text = [
      recordLine({
        sql: "SELECT 1",
        ts: "2026-06-20T10:00:00.000Z",
        status: "ok",
        duration_ms: 5,
      }),
      recordLine({
        sql: "SELECT bad",
        ts: "2026-06-20T11:00:00.000Z",
        status: "error",
        duration_ms: 12,
        rows: null,
        rows_affected: null,
        error: { category: "query", message: "boom" },
      }),
    ].join("\n");
    mockFetch.mockResolvedValueOnce(text);

    const wrapper = mount(HistorySidebar, mountOptions);
    await flushPromises();

    const rows = wrapper.findAll("[data-testid='history-row']");
    expect(rows).toHaveLength(2);

    // Newest-first sort: the error row comes before the ok row.
    const badges = wrapper.findAll("[data-testid='history-status']");
    expect(badges[0]!.classes()).toContain("badge--error");
    expect(badges[1]!.classes()).toContain("badge--ok");

    expect(rows[0]!.text()).toContain("12");
    expect(rows[1]!.text()).toContain("5");
    wrapper.unmount();
  });

  it("truncates SQL displayed in the row but preserves the full text for replay", async () => {
    const longSql = "SELECT * FROM t WHERE col = '" + "x".repeat(200) + "'";
    mockFetch.mockResolvedValueOnce(recordLine({ sql: longSql }));

    const wrapper = mount(HistorySidebar, mountOptions);
    await flushPromises();

    const row = wrapper.find("[data-testid='history-row']");
    // Truncated to <= 80 chars (the rendered preview length is implementation
    // detail; the row must not show the entire 200-char tail).
    expect(row.text().length).toBeLessThan(longSql.length);

    await wrapper.find("[data-testid='history-replay']").trigger("click");
    const emitted = wrapper.emitted("replay");
    expect(emitted).toBeDefined();
    expect(emitted![0]).toEqual([longSql]);
    wrapper.unmount();
  });

  it("calls apiFetch again when the refresh button is clicked", async () => {
    mockFetch.mockResolvedValueOnce("");
    mockFetch.mockResolvedValueOnce(recordLine({ sql: "fresh" }));

    const wrapper = mount(HistorySidebar, mountOptions);
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(1);

    await wrapper.find("[data-testid='history-refresh']").trigger("click");
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(wrapper.findAll("[data-testid='history-row']")).toHaveLength(1);
    wrapper.unmount();
  });

  it("renders the load-error banner when fetch fails", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network down"));

    const wrapper = mount(HistorySidebar, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='history-error']").exists()).toBe(true);
    expect(wrapper.text()).toContain("history.error.load");
    wrapper.unmount();
  });

  it("exposes refresh() so the parent page can call it after Run", async () => {
    mockFetch.mockResolvedValueOnce("");
    mockFetch.mockResolvedValueOnce(recordLine({ sql: "after run" }));

    const wrapper = mount(HistorySidebar, mountOptions);
    await flushPromises();

    const exposed = wrapper.vm as unknown as { refresh: () => Promise<void> };
    expect(typeof exposed.refresh).toBe("function");

    await exposed.refresh();
    await flushPromises();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    wrapper.unmount();
  });
});
