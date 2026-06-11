import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";
import SqlPage from "../app/pages/connections/[id]/sql.vue";

// vi.hoisted lets the mock factories below close over the spies safely.
// useQueryExecutionFactory is the constructor mock — it records the
// (connectionId, options?) call so we can assert the page passed the
// route id through.
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  useQueryExecutionFactory: vi.fn(),
}));

let resultRef: Ref<{
  columns: Array<{ name: string; declared_type: string | null }>;
  rows: Array<Array<unknown>>;
  rows_affected: number;
} | null>;
let stateRef: Ref<"idle" | "loading" | "error">;
let lastErrorRef: Ref<{ category: string; message: string; i18nKey: string } | null>;

vi.mock("../app/composables/useQueryExecution", () => ({
  useQueryExecution: (id: string, options?: unknown) => {
    mocks.useQueryExecutionFactory(id, options);
    return {
      result: resultRef,
      state: stateRef,
      lastError: lastErrorRef,
      run: mocks.run,
    };
  },
}));

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { id: "route-id" } }),
}));

const mountOptions = {
  global: {
    stubs: {
      NuxtLink: { template: "<a><slot /></a>" },
    },
  },
};

describe("SqlPage", () => {
  beforeEach(() => {
    resultRef = ref(null);
    stateRef = ref<"idle" | "loading" | "error">("idle");
    lastErrorRef = ref<{
      category: string;
      message: string;
      i18nKey: string;
    } | null>(null);
    mocks.run.mockReset();
    mocks.useQueryExecutionFactory.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes the route id through to useQueryExecution", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(mocks.useQueryExecutionFactory).toHaveBeenCalledTimes(1);
    expect(mocks.useQueryExecutionFactory.mock.calls[0]![0]).toBe("route-id");
    wrapper.unmount();
  });

  it("renders the empty-state copy when result is null", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='result-empty']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-summary']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("dispatches run() with the textarea contents when the Run button is clicked", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const input = wrapper.find("[data-testid='sql-input']");
    await input.setValue("SELECT 1 AS x");
    await wrapper.find("[data-testid='run-button']").trigger("click");

    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith("SELECT 1 AS x");
    wrapper.unmount();
  });

  it("dispatches run() when Ctrl+Enter is pressed in the textarea", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const input = wrapper.find("[data-testid='sql-input']");
    await input.setValue("SELECT 2");
    await input.trigger("keydown", { key: "Enter", ctrlKey: true });

    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith("SELECT 2");
    wrapper.unmount();
  });

  it("dispatches run() when Meta+Enter is pressed in the textarea (mac path)", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const input = wrapper.find("[data-testid='sql-input']");
    await input.setValue("SELECT 3");
    await input.trigger("keydown", { key: "Enter", metaKey: true });

    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith("SELECT 3");
    wrapper.unmount();
  });

  it("does NOT dispatch run() on plain Enter (newline insertion stays on)", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const input = wrapper.find("[data-testid='sql-input']");
    await input.setValue("SELECT 4");
    await input.trigger("keydown", { key: "Enter" });

    expect(mocks.run).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("renders the result summary with column count, row count, and rows_affected", async () => {
    resultRef.value = {
      columns: [
        { name: "id", declared_type: "INTEGER" },
        { name: "label", declared_type: "TEXT" },
      ],
      rows: [
        [1, "Prod"],
        [2, "Staging"],
        [3, "Dev"],
      ],
      rows_affected: 0,
    };

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const summary = wrapper.find("[data-testid='result-summary']");
    expect(summary.exists()).toBe(true);
    expect(summary.text()).toContain("2");
    expect(summary.text()).toContain("3");
    expect(summary.text()).toContain("0");
    wrapper.unmount();
  });

  it("renders the result preview with the JSON of rows[0] when at least one row exists", async () => {
    resultRef.value = {
      columns: [{ name: "x", declared_type: "INTEGER" }],
      rows: [[42]],
      rows_affected: 0,
    };

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const preview = wrapper.find("[data-testid='result-preview']");
    expect(preview.exists()).toBe(true);
    expect(preview.text()).toContain("42");
    wrapper.unmount();
  });

  it("does not render the result preview when rows is empty", async () => {
    resultRef.value = {
      columns: [],
      rows: [],
      rows_affected: 7,
    };

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='result-summary']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders the error banner with the i18nKey resolved by the page", async () => {
    lastErrorRef.value = {
      category: "query",
      message: "syntax error",
      i18nKey: "error.prefix.query",
    };

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const banner = wrapper.find("[data-testid='error-banner']");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("error.prefix.query");
    expect(banner.text()).toContain("syntax error");
    wrapper.unmount();
  });

  it("disables the Run button while state is 'loading'", async () => {
    stateRef.value = "loading";

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const button = wrapper.find("[data-testid='run-button']");
    expect(button.attributes("disabled")).toBeDefined();
    wrapper.unmount();
  });
});
