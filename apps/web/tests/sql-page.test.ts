import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, ref, type Ref } from "vue";
import ResultGrid from "../app/components/ResultGrid.vue";
import SqlPage from "../app/pages/connections/[id]/sql.vue";
import { SIDEBAR_DEFAULT_WIDTH, SIDEBAR_NUDGE } from "../app/utils/splitter";

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
  dumpButtonConstructed: vi.fn(),
  restorePanelConstructed: vi.fn(),
  loadEditContext: vi.fn(),
  editContextConstructed: vi.fn(),
}));

let resultRef: Ref<{
  columns: Array<{ name: string; declared_type: string | null }>;
  rows: Array<Array<unknown>>;
  rows_affected: number;
} | null>;
let stateRef: Ref<"idle" | "loading" | "error">;
let lastErrorRef: Ref<{ category: string; message: string; i18nKey: string } | null>;
let sourceTableRef: Ref<{ schema: string | null; name: string } | null>;

vi.mock("../app/composables/useQueryExecution", () => ({
  useQueryExecution: (id: string, options?: unknown) => {
    mocks.useQueryExecutionFactory(id, options);
    return {
      result: resultRef,
      sourceTable: sourceTableRef,
      state: stateRef,
      lastError: lastErrorRef,
      run: mocks.run,
    };
  },
}));

// The edit context is stubbed the same way, for the same reason: the page's
// job is to ask for the browsed table's key and hand the answer to the grid,
// and the asking is what these tests are about. What the answer is made of is
// use-edit-context.test.ts.
let editContextRef: Ref<{
  connectionId: string;
  table: { schema: string | null; name: string };
  pk: string[];
} | null>;
let noPkRef: Ref<boolean>;

vi.mock("../app/composables/useEditContext", () => ({
  useEditContext: (id: string, options?: unknown) => {
    mocks.editContextConstructed(id, options);
    return {
      table: ref(null),
      pk: ref([]),
      context: editContextRef,
      noPk: noPkRef,
      load: mocks.loadEditContext,
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
let schemaTablesRef: Ref<ReadonlyArray<{ schema: string | null; name: string }>>;
let schemaStateRef: Ref<"idle" | "loading" | "error">;

vi.mock("../app/components/SchemaBrowser.vue", () => ({
  default: defineComponent({
    name: "SchemaBrowser",
    props: ["connectionId", "driver"],
    emits: ["insert", "browse"],
    setup(props, { expose }) {
      mocks.schemaConstructed(props.connectionId);
      // Mirrors the real component's defineExpose (ticket 0032 slice A):
      // the page reads the fetched list off the sidebar rather than
      // fetching a second copy of it.
      expose({ tables: schemaTablesRef, state: schemaStateRef });
      return () => h("aside", { "data-testid": "schema-browser" });
    },
  }),
}));

// The page has no `GET /connections/:id` to ask, so it reads the driver out
// of the list (ADR-0072). Stubbed here because the real composable fetches on
// mount and resolves the API base from the runtime config, which this suite
// runs without — `use-connections.test.ts` owns that behaviour.
let connectionListRef: Ref<ReadonlyArray<{ id: string; label: string; driver: string }>>;

vi.mock("../app/composables/useConnections", () => ({
  useConnections: () => ({
    list: connectionListRef,
    state: ref("idle"),
    lastError: ref(null),
    refresh: vi.fn(),
    register: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  }),
}));

// AiPanel stub. Page-level coverage just verifies the mount and that
// the panel receives the current SQL text and that its `insert` event
// reuses the schema browser's caret-aware splicer. Composable surface
// and panel behaviour are covered by use-ai-assist.test.ts and
// ai-panel.test.ts.
let aiPanelProps: { currentSql?: string; tables?: ReadonlyArray<unknown> } | null = null;

vi.mock("../app/components/AiPanel.vue", () => ({
  default: defineComponent({
    name: "AiPanel",
    props: ["currentSql", "tables"],
    emits: ["insert"],
    setup(props) {
      mocks.aiPanelConstructed();
      // Held rather than snapshotted: `tables` arrives after the sidebar's
      // fetch resolves, so a test has to read the prop as it stands then,
      // not as it stood at mount.
      aiPanelProps = props;
      return () => h("aside", { "data-testid": "ai-panel" });
    },
  }),
}));

// DumpButton stub. It reads the API base out of the runtime config while it
// sets up, and this suite runs without a Nuxt instance. Its behaviour is
// covered by dump-button.test.ts and use-dump.test.ts; here we only check the
// mount and the id it is handed.
vi.mock("../app/components/DumpButton.vue", () => ({
  default: defineComponent({
    name: "DumpButton",
    props: ["connectionId", "apiBase"],
    setup(props) {
      mocks.dumpButtonConstructed(props.connectionId);
      return () => h("div", { "data-testid": "dump-button" });
    },
  }),
}));

// RestorePanel stub, for the same reason as the DumpButton one above. Its
// behaviour is covered by restore-panel.test.ts and use-restore.test.ts.
vi.mock("../app/components/RestorePanel.vue", () => ({
  default: defineComponent({
    name: "RestorePanel",
    props: ["connectionId", "apiBase"],
    setup(props) {
      mocks.restorePanelConstructed(props.connectionId);
      return () => h("div", { "data-testid": "restore-panel" });
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
    sourceTableRef = ref(null);
    connectionListRef = ref([]);
    editContextRef = ref(null);
    noPkRef = ref(false);
    stateRef = ref<"idle" | "loading" | "error">("idle");
    schemaTablesRef = ref([]);
    schemaStateRef = ref<"idle" | "loading" | "error">("loading");
    aiPanelProps = null;
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
    mocks.dumpButtonConstructed.mockReset();
    mocks.restorePanelConstructed.mockReset();
    mocks.loadEditContext.mockReset();
    mocks.editContextConstructed.mockReset();
    // The sidebar remembers its width, so without a storage of its own per
    // test the first drag would decide the starting width of every test
    // after it. See use-theme.test.ts: the environment's own `localStorage`
    // is inert here, so it has to be stubbed rather than cleared.
    const map = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
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

  // The export controls follow the grid exactly: a write-style statement has
  // nothing to hand a spreadsheet but a header line.
  it("mounts the export toolbar with the grid, and not without it", async () => {
    resultRef.value = {
      columns: [{ name: "x", declared_type: "INTEGER" }],
      rows: [[42]],
      rows_affected: 0,
    };
    const withRows = mount(SqlPage, mountOptions);
    await flushPromises();
    expect(withRows.find("[data-testid='result-export__copy']").exists()).toBe(true);
    withRows.unmount();

    resultRef.value = { columns: [], rows: [], rows_affected: 7 };
    const withoutRows = mount(SqlPage, mountOptions);
    await flushPromises();
    expect(withoutRows.find("[data-testid='result-export__copy']").exists()).toBe(false);
    withoutRows.unmount();
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
    // The English half is what a user pastes into a search. `t` echoes keys
    // in this suite, so this wording came from the en bundle, not from `t`.
    expect(banner.find("[data-testid='error-banner__original']").text()).toContain("Query error:");
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

  // ---- dialect seam (ADR-0072, rung 7 slice C) -------------------------

  it("hands the schema browser the driver of the connection it is looking at", async () => {
    connectionListRef = ref([
      { id: "other-id", label: "pg", driver: "postgres" },
      { id: "route-id", label: "shop", driver: "mysql" },
    ]);
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.findComponent({ name: "SchemaBrowser" }).props("driver")).toBe("mysql");
    wrapper.unmount();
  });

  it("leaves the driver undefined until the connection list arrives", async () => {
    // Not a defensive branch: the list is fetched on mount, so this is the
    // state the sidebar renders in first. `undefined` resolves to ANSI, and
    // guessing a driver here would be worse than admitting we do not know.
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();
    expect(wrapper.findComponent({ name: "SchemaBrowser" }).props("driver")).toBeUndefined();

    connectionListRef.value = [{ id: "route-id", label: "shop", driver: "mysql" }];
    await flushPromises();
    expect(wrapper.findComponent({ name: "SchemaBrowser" }).props("driver")).toBe("mysql");
    wrapper.unmount();
  });

  it("leaves the driver undefined when the route id is not in the list", async () => {
    connectionListRef = ref([{ id: "other-id", label: "pg", driver: "postgres" }]);
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.findComponent({ name: "SchemaBrowser" }).props("driver")).toBeUndefined();
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

  it("mounts the dump button with the route id passed through (0029)", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='dump-button']").exists()).toBe(true);
    expect(mocks.dumpButtonConstructed).toHaveBeenCalledWith("route-id");
    wrapper.unmount();
  });

  it("mounts the restore panel with the route id passed through (0030)", async () => {
    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='restore-panel']").exists()).toBe(true);
    expect(mocks.restorePanelConstructed).toHaveBeenCalledWith("route-id");
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

  // Desktop ADR-0083. The page owns the layout, so it is the only place the
  // divider's width can actually be seen to do something; the divider itself
  // is covered by sidebar-splitter.test.ts and the sizing rules by
  // splitter.test.ts.
  describe("the resizable sidebar", () => {
    function sidebarWidth(wrapper: ReturnType<typeof mount>): string | undefined {
      return (wrapper.find(".columns").element as HTMLElement).style.getPropertyValue(
        "--sidebar-width",
      );
    }

    it("mounts a divider between the editor and the sidebar", async () => {
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      expect(wrapper.find("[role='separator']").exists()).toBe(true);
      expect(sidebarWidth(wrapper)).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
      wrapper.unmount();
    });

    it("widens the sidebar when the divider is dragged", async () => {
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      wrapper.findComponent({ name: "SidebarSplitter" }).vm.$emit("resize", 360);
      await flushPromises();

      expect(sidebarWidth(wrapper)).toBe("360px");
      wrapper.unmount();
    });

    it("moves the sidebar one step at a time from the keyboard", async () => {
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      await wrapper.find("[role='separator']").trigger("keydown", { key: "ArrowLeft" });
      await flushPromises();

      expect(sidebarWidth(wrapper)).toBe(`${SIDEBAR_DEFAULT_WIDTH + SIDEBAR_NUDGE}px`);
      wrapper.unmount();
    });

    it("puts the sidebar back on a double-click", async () => {
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      wrapper.findComponent({ name: "SidebarSplitter" }).vm.$emit("resize", 420);
      await flushPromises();
      await wrapper.find("[role='separator']").trigger("dblclick");
      await flushPromises();

      expect(sidebarWidth(wrapper)).toBe(`${SIDEBAR_DEFAULT_WIDTH}px`);
      wrapper.unmount();
    });
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
  // Browse (ticket 0028 slice A). The generated statement is put in the
  // editor before it runs, so nothing executes that the user cannot see and
  // re-run — and the source table rides along as the second argument,
  // because that provenance is what will decide editability.
  it("loads a browsed statement into the editor and runs it with its source table", async () => {
    mocks.run.mockResolvedValueOnce(undefined);

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    const schema = wrapper.findComponent({ name: "SchemaBrowser" });
    schema.vm.$emit("browse", {
      sql: 'SELECT * FROM "public"."users" LIMIT 100;',
      table: { schema: "public", name: "users" },
    });
    await flushPromises();

    const input = wrapper.find<HTMLTextAreaElement>("[data-testid='sql-input']").element;
    expect(input.value).toBe('SELECT * FROM "public"."users" LIMIT 100;');
    expect(mocks.run).toHaveBeenCalledTimes(1);
    expect(mocks.run).toHaveBeenCalledWith('SELECT * FROM "public"."users" LIMIT 100;', {
      schema: "public",
      name: "users",
    });
    wrapper.unmount();
  });

  it("refreshes history after a browse, which is a run like any other", async () => {
    mocks.run.mockResolvedValueOnce(undefined);

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    wrapper.findComponent({ name: "SchemaBrowser" }).vm.$emit("browse", {
      sql: 'SELECT * FROM "t" LIMIT 100;',
      table: { schema: null, name: "t" },
    });
    await flushPromises();

    expect(mocks.sidebarRefresh).toHaveBeenCalledTimes(1);
    wrapper.unmount();
  });

  it("passes no source table when the user presses Run themselves", async () => {
    // The typed-SQL path must stay provenance-free even right after a
    // browse: whatever is in the box now is the user's text, and a `SELECT`
    // cannot be trusted to name the table it reads.
    mocks.run.mockResolvedValue(undefined);

    const wrapper = mount(SqlPage, mountOptions);
    await flushPromises();

    wrapper.findComponent({ name: "SchemaBrowser" }).vm.$emit("browse", {
      sql: 'SELECT * FROM "t" LIMIT 100;',
      table: { schema: null, name: "t" },
    });
    await flushPromises();

    await wrapper.find("[data-testid='sql-input']").setValue('SELECT * FROM "t" JOIN u USING (id)');
    await wrapper.find("[data-testid='run-button']").trigger("click");
    await flushPromises();

    expect(mocks.run).toHaveBeenLastCalledWith('SELECT * FROM "t" JOIN u USING (id)');
    wrapper.unmount();
  });

  // Inline editing, page half (ticket 0028 slice E). The grid is handed an
  // edit context or nothing; everything about *deciding* that lives in
  // useEditContext, and everything about *editing* lives in ResultGrid. What
  // is tested here is the wiring between them — including the one thing
  // neither can see on its own: that the context follows the rows actually on
  // screen, even when a run fails.
  describe("inline editing", () => {
    const USERS = { schema: "public", name: "users" };
    const BROWSE_SQL = 'SELECT * FROM "public"."users" LIMIT 100;';

    /** Mimic the real composable: provenance is recorded on success only. */
    function runSucceeds() {
      mocks.run.mockImplementation(
        (_sql: string, table?: { schema: string | null; name: string }) => {
          sourceTableRef.value = table ?? null;
          return Promise.resolve();
        },
      );
    }

    function withRows() {
      resultRef.value = {
        columns: [
          { name: "id", declared_type: "INTEGER" },
          { name: "email", declared_type: "TEXT" },
        ],
        rows: [[1, "ann@example.com"]],
        rows_affected: 0,
      };
    }

    async function browse(wrapper: ReturnType<typeof mount>, table = USERS, sql = BROWSE_SQL) {
      wrapper.findComponent({ name: "SchemaBrowser" }).vm.$emit("browse", { sql, table });
      await flushPromises();
    }

    it("passes the route id through to useEditContext", async () => {
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      expect(mocks.editContextConstructed).toHaveBeenCalledTimes(1);
      expect(mocks.editContextConstructed.mock.calls[0]![0]).toBe("route-id");
      wrapper.unmount();
    });

    it("asks for the browsed table's key once the rows are in", async () => {
      runSucceeds();
      withRows();
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      await browse(wrapper);

      expect(mocks.loadEditContext).toHaveBeenLastCalledWith(USERS);
      wrapper.unmount();
    });

    it("takes the key away when the user runs their own SQL", async () => {
      runSucceeds();
      withRows();
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();
      await browse(wrapper);

      await wrapper.find("[data-testid='sql-input']").setValue("SELECT 1");
      await wrapper.find("[data-testid='run-button']").trigger("click");
      await flushPromises();

      expect(mocks.loadEditContext).toHaveBeenLastCalledWith(null);
      wrapper.unmount();
    });

    it("keeps the browsed table's key when a later query fails", async () => {
      // The failed run leaves the browse's rows on screen. Those rows are
      // still that table's, so taking their key away would make a grid the
      // user is still looking at silently read-only.
      runSucceeds();
      withRows();
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();
      await browse(wrapper);

      // A failure never touches provenance — same as useQueryExecution.
      mocks.run.mockImplementation(() => Promise.resolve());
      await wrapper.find("[data-testid='sql-input']").setValue("SELECT nope");
      await wrapper.find("[data-testid='run-button']").trigger("click");
      await flushPromises();

      expect(mocks.loadEditContext).toHaveBeenLastCalledWith(USERS);
      wrapper.unmount();
    });

    it("hands the grid the context once the key is known", async () => {
      runSucceeds();
      withRows();
      editContextRef.value = { connectionId: "route-id", table: USERS, pk: ["id"] };
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      expect(wrapper.findComponent(ResultGrid).props("edit")).toEqual({
        connectionId: "route-id",
        table: USERS,
        pk: ["id"],
      });
      wrapper.unmount();
    });

    it("hands the grid nothing when the result is not editable", async () => {
      withRows();
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      expect(wrapper.findComponent(ResultGrid).props("edit")).toBeNull();
      expect(wrapper.find("[data-testid='readonly-no-pk']").exists()).toBe(false);
      wrapper.unmount();
    });

    it("says why the grid is read-only when the table has no primary key", async () => {
      withRows();
      noPkRef.value = true;
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();

      const note = wrapper.find("[data-testid='readonly-no-pk']");
      expect(note.exists()).toBe(true);
      expect(note.text()).toBe("result.edit.readonly-no-pk");
      wrapper.unmount();
    });

    it("re-runs the statement that produced the rows after a save", async () => {
      // Save writes row by row; the grid it wrote through is now a stale
      // read. Re-running the browse is how the user sees what landed.
      runSucceeds();
      withRows();
      editContextRef.value = { connectionId: "route-id", table: USERS, pk: ["id"] };
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();
      await browse(wrapper);
      mocks.run.mockClear();
      mocks.sidebarRefresh.mockClear();

      wrapper.findComponent(ResultGrid).vm.$emit("saved");
      await flushPromises();

      expect(mocks.run).toHaveBeenCalledTimes(1);
      expect(mocks.run).toHaveBeenCalledWith(BROWSE_SQL, USERS);
      expect(mocks.sidebarRefresh).toHaveBeenCalledTimes(1);
      wrapper.unmount();
    });

    it("re-runs the browse, not whatever the user has since typed", async () => {
      // The editor is a scratchpad. After a save, refreshing the grid with an
      // unrelated query the user happens to be drafting would replace the
      // rows they just wrote to with something else entirely.
      runSucceeds();
      withRows();
      editContextRef.value = { connectionId: "route-id", table: USERS, pk: ["id"] };
      const wrapper = mount(SqlPage, mountOptions);
      await flushPromises();
      await browse(wrapper);

      await wrapper.find("[data-testid='sql-input']").setValue("DROP TABLE users");
      mocks.run.mockClear();
      wrapper.findComponent(ResultGrid).vm.$emit("saved");
      await flushPromises();

      expect(mocks.run).toHaveBeenCalledWith(BROWSE_SQL, USERS);
      wrapper.unmount();
    });
  });
  // Ticket 0032 slice A. The page is the only place that can join the two:
  // the sidebar fetched the tables, the panel needs them. What matters is
  // that it forwards a *fetched* list and nothing else — an empty array is
  // a claim the panel will put in a prompt, so it must not be made while
  // the fetch is still out or after it failed.
  describe("table list handed to the AI panel", () => {
    it("withholds the list while the sidebar is still fetching", async () => {
      const wrapper = mount(SqlPage);
      await flushPromises();

      expect(aiPanelProps?.tables).toBeUndefined();
      wrapper.unmount();
    });

    it("forwards the tables once the sidebar has them", async () => {
      const wrapper = mount(SqlPage);
      await flushPromises();

      schemaTablesRef.value = [
        { schema: "public", name: "users" },
        { schema: null, name: "orders" },
      ];
      schemaStateRef.value = "idle";
      await flushPromises();

      expect(aiPanelProps?.tables).toEqual([
        { schema: "public", name: "users" },
        { schema: null, name: "orders" },
      ]);
      wrapper.unmount();
    });

    it("forwards an empty list once the sidebar reports there are none", async () => {
      const wrapper = mount(SqlPage);
      await flushPromises();

      schemaStateRef.value = "idle";
      await flushPromises();

      expect(aiPanelProps?.tables).toStrictEqual([]);
      wrapper.unmount();
    });

    it("withholds the list when the sidebar's fetch failed", async () => {
      const wrapper = mount(SqlPage);
      await flushPromises();

      schemaStateRef.value = "error";
      await flushPromises();

      // The sidebar's `tables` is still [] here, and forwarding it would
      // tell the model the connection has no tables when the truth is that
      // we never found out.
      expect(aiPanelProps?.tables).toBeUndefined();
      wrapper.unmount();
    });
  });
});
