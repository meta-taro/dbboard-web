import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref, type Ref } from "vue";
import SqlPage from "../app/pages/connections/[id]/sql.vue";

// vi.hoisted lets the mock factories below close over the spies safely.
// useQueryExecutionFactory is the constructor mock — it records the
// (connectionId, options?) call so we can assert the page passed the
// route id through. sidebarRefresh is the spy the HistorySidebar stub
// exposes via defineExpose so the page can refresh history after Run.
const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  useQueryExecutionFactory: vi.fn(),
  sidebarRefresh: vi.fn(),
  sidebarConstructed: vi.fn(),
  schemaConstructed: vi.fn(),
  aiPanelConstructed: vi.fn(),
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

// Stub the sidebar so the page-level assertions don't race with the
// sidebar's own mount-time fetch and so we can spy on refresh(). The
// stub exposes `refresh` via defineExpose, mirroring the production
// component's surface used by the parent page.
vi.mock("../app/components/HistorySidebar.vue", () => ({
  default: defineComponent({
    name: "HistorySidebar",
    props: ["connectionId"],
    emits: ["replay"],
    setup(props, { expose }) {
      mocks.sidebarConstructed(props.connectionId);
      expose({ refresh: mocks.sidebarRefresh });
      return () => h("aside", { "data-testid": "history-sidebar" });
    },
  }),
}));

// Same stub pattern for the schema browser. The page-level tests only
// care that it mounts and that `insert` events round-trip into the
// editor; the real component is covered by schema-browser.test.ts.
vi.mock("../app/components/SchemaBrowser.vue", () => ({
  default: defineComponent({
    name: "SchemaBrowser",
    props: ["connectionId"],
    emits: ["insert"],
    setup(props) {
      mocks.schemaConstructed(props.connectionId);
      return () => h("aside", { "data-testid": "schema-browser" });
    },
  }),
}));

// AiPanel stub. Page-level coverage just verifies the mount and that
// the panel receives the current SQL text and that its `insert` event
// reuses the schema browser's caret-aware splicer. Composable surface
// and panel behaviour are covered by use-ai-assist.test.ts and
// ai-panel.test.ts.
vi.mock("../app/components/AiPanel.vue", () => ({
  default: defineComponent({
    name: "AiPanel",
    props: ["currentSql"],
    emits: ["insert"],
    setup() {
      mocks.aiPanelConstructed();
      return () => h("aside", { "data-testid": "ai-panel" });
    },
  }),
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
    mocks.sidebarRefresh.mockReset();
    mocks.sidebarConstructed.mockReset();
    mocks.schemaConstructed.mockReset();
    mocks.aiPanelConstructed.mockReset();
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
    expect(wrapper.find("[data-testid='result-grid']").exists()).toBe(false);
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

  it("does NOT dispatch run() when Ctrl+Enter fires mid-IME composition (isComposing=true)", async () => {
    // Slice 2 explicitly deferred this guard because happy-dom couldn't model
    // `KeyboardEvent.isComposing` as a runtime IME concept — but the field is
    // perfectly representable as an event payload, and a Japanese / Chinese /
    // Korean user pressing Enter to commit a candidate must NOT trigger the
    // query. Slice 3 closes this gap.
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const input = wrapper.find("[data-testid='sql-input']");
    await input.setValue("SELECT 中");
    await input.trigger("keydown", { key: "Enter", ctrlKey: true, isComposing: true });

    expect(mocks.run).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does NOT dispatch run() when Ctrl+Enter fires with the legacy keyCode 229 (Safari/Android)", async () => {
    // Safari and older Android WebViews do not always set isComposing on the
    // keydown that commits an IME candidate, but they DO emit a synthetic
    // event with keyCode === 229. The guard must catch both paths.
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const input = wrapper.find("[data-testid='sql-input']");
    await input.setValue("SELECT 中");
    await input.trigger("keydown", { key: "Enter", ctrlKey: true, keyCode: 229 });

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

  it("mounts the ResultGrid container when result has at least one row", async () => {
    // Slice 2 rendered a JSON <pre> preview as a stop-gap. Slice 3 swaps in
    // the virtualised grid — the page only owns the mount point; ResultGrid
    // itself is covered by result-grid.test.ts.
    resultRef.value = {
      columns: [{ name: "x", declared_type: "INTEGER" }],
      rows: [[42]],
      rows_affected: 0,
    };

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='result-grid']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-preview']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("does not mount the ResultGrid when rows is empty (write-style statements)", async () => {
    // INSERT / UPDATE / DELETE return zero columns and zero rows — the
    // summary line carries rows_affected, but there's nothing to grid.
    resultRef.value = {
      columns: [],
      rows: [],
      rows_affected: 7,
    };

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='result-summary']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='result-grid']").exists()).toBe(false);
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

  it("mounts the history sidebar with the route id passed through", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='history-sidebar']").exists()).toBe(true);
    expect(mocks.sidebarConstructed).toHaveBeenCalledWith("route-id");
    wrapper.unmount();
  });

  it("loads the SQL from a sidebar replay event into the editor without running", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const sidebar = wrapper.findComponent({ name: "HistorySidebar" });
    sidebar.vm.$emit("replay", "SELECT replayed FROM history");
    await flushPromises();

    const input = wrapper.find<HTMLTextAreaElement>("[data-testid='sql-input']").element;
    expect(input.value).toBe("SELECT replayed FROM history");
    expect(mocks.run).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("calls the sidebar's refresh() after a successful Run", async () => {
    mocks.run.mockResolvedValueOnce(undefined);

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='sql-input']").setValue("SELECT 1");
    await wrapper.find("[data-testid='run-button']").trigger("click");
    await flushPromises();

    expect(mocks.sidebarRefresh).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("still calls the sidebar's refresh() when Run fails (failures are also history)", async () => {
    mocks.run.mockResolvedValueOnce(undefined); // useQueryExecution swallows internally
    lastErrorRef.value = { category: "query", message: "boom", i18nKey: "error.prefix.query" };

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='sql-input']").setValue("SELEC bad");
    await wrapper.find("[data-testid='run-button']").trigger("click");
    await flushPromises();

    expect(mocks.sidebarRefresh).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("mounts the schema browser with the route id passed through (0017)", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='schema-browser']").exists()).toBe(true);
    expect(mocks.schemaConstructed).toHaveBeenCalledWith("route-id");
    wrapper.unmount();
  });

  it("mounts the AI panel and forwards the current SQL editor value to it", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='ai-panel']").exists()).toBe(true);
    expect(mocks.aiPanelConstructed).toHaveBeenCalled();

    const panel = wrapper.findComponent({ name: "AiPanel" });
    // The panel mounts before the user has typed anything.
    expect(panel.props("currentSql")).toBe("");

    await wrapper.find("[data-testid='sql-input']").setValue("SELECT 99");
    await flushPromises();
    expect(panel.props("currentSql")).toBe("SELECT 99");
    wrapper.unmount();
  });

  it("splices an AI panel insert into the textarea via the same caret-aware path as the schema browser", async () => {
    const wrapper = mount(SqlPage, { ...mountOptions, attachTo: document.body });
    await flushPromises();

    const textarea = wrapper.find<HTMLTextAreaElement>("[data-testid='sql-input']");
    await textarea.setValue("-- prompt result\n");
    textarea.element.selectionStart = textarea.element.selectionEnd = textarea.element.value.length;

    const panel = wrapper.findComponent({ name: "AiPanel" });
    panel.vm.$emit("insert", "SELECT COUNT(*) FROM users;");
    await flushPromises();

    expect(textarea.element.value).toBe("-- prompt result\nSELECT COUNT(*) FROM users;");
    wrapper.unmount();
  });

  it("splices an emitted insert identifier into the textarea at the caret position", async () => {
    const wrapper = mount(SqlPage, { ...mountOptions, attachTo: document.body });
    await flushPromises();

    const textarea = wrapper.find<HTMLTextAreaElement>("[data-testid='sql-input']");
    await textarea.setValue("SELECT * FROM ");
    // Place caret at end of "SELECT * FROM ".
    textarea.element.selectionStart = textarea.element.selectionEnd = textarea.element.value.length;

    const schema = wrapper.findComponent({ name: "SchemaBrowser" });
    schema.vm.$emit("insert", '"public"."users"');
    await flushPromises();

    expect(textarea.element.value).toBe('SELECT * FROM "public"."users"');
    expect(textarea.element.selectionStart).toBe(textarea.element.value.length);
    expect(textarea.element.selectionEnd).toBe(textarea.element.value.length);
    wrapper.unmount();
  });
});
