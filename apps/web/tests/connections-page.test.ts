import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";
import ConnectionsPage from "../app/pages/connections/index.vue";

// vi.hoisted runs before imports so the mock factory below can safely close
// over `mocks.register/remove/refresh`. The reactive refs themselves are
// re-created per-test in beforeEach so each test starts on a clean slate.
const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}));

interface Row {
  id: string;
  label: string;
  driver: string;
  parts?: { host?: string; port?: number; user?: string; database?: string; sslMode?: string };
}

let listRef: Ref<Row[]>;
let driversRef: Ref<string[]>;
let driversErrorRef: Ref<{ category: string; message: string; i18nKey: string } | null>;
let stateRef: Ref<"idle" | "loading" | "error">;
let lastErrorRef: Ref<{ category: string; message: string; i18nKey: string } | null>;

vi.mock("../app/composables/useConnections", () => ({
  useConnections: () => ({
    list: listRef,
    state: stateRef,
    lastError: lastErrorRef,
    register: mocks.register,
    update: mocks.update,
    remove: mocks.remove,
    refresh: mocks.refresh,
  }),
}));

// The driver list is server-owned (0027 slice E), so the page reads it from
// its own composable rather than restating it in the template. Mocked here
// for the same reason useConnections is: these are page tests, not HTTP.
vi.mock("../app/composables/useDrivers", () => ({
  useDrivers: () => ({
    drivers: driversRef,
    lastError: driversErrorRef,
  }),
}));

// vue-i18n requires `app.use(createI18n(...))` under a real Nuxt runtime;
// the page test runs in plain happy-dom. Stub useI18n so the page can call
// `t(key)` without needing a configured i18n instance. The translated copy
// itself is verified by tests/i18n-locale-parity.test.ts.
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const mountOptions = {
  global: {
    stubs: {
      NuxtLink: { template: "<a><slot /></a>" },
    },
  },
};

describe("ConnectionsPage", () => {
  beforeEach(() => {
    listRef = ref([]);
    driversRef = ref<string[]>(["postgres", "null"]);
    driversErrorRef = ref<{
      category: string;
      message: string;
      i18nKey: string;
    } | null>(null);
    stateRef = ref<"idle" | "loading" | "error">("idle");
    lastErrorRef = ref<{
      category: string;
      message: string;
      i18nKey: string;
    } | null>(null);
    mocks.register.mockReset();
    mocks.update.mockReset();
    mocks.remove.mockReset();
    mocks.refresh.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("renders the empty-state copy when no connections are registered", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    expect(wrapper.text()).toContain("connections.empty");
    expect(wrapper.find("[data-testid='connection-row']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("renders one row per registered connection", async () => {
    listRef.value = [
      { id: "abc", label: "Prod", driver: "postgres" },
      { id: "def", label: "Staging", driver: "postgres" },
    ];

    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    const rows = wrapper.findAll("[data-testid='connection-row']");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.text()).toContain("Prod");
    expect(rows[0]!.text()).toContain("abc");
    expect(rows[1]!.text()).toContain("Staging");
    wrapper.unmount();
  });

  // Rewritten for 0027 slice C. Until then the form had one
  // `connection-string-input` and this test drove it; the URL is now the
  // escape hatch rather than the only way in, so the same assertion moved
  // to "still registers a pasted provider URL" below.
  it("calls register() with the parts as separate fields when the add form submits", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Neon");
    await wrapper.find("[data-testid='driver-input']").setValue("postgres");
    await wrapper.find("[data-testid='host-input']").setValue("db.example.com");
    await wrapper.find("[data-testid='port-input']").setValue("6543");
    await wrapper.find("[data-testid='user-input']").setValue("app");
    await wrapper.find("[data-testid='password-input']").setValue("s3cr3t");
    await wrapper.find("[data-testid='database-input']").setValue("main");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.register).toHaveBeenCalledWith({
      label: "Neon",
      driver: "postgres",
      host: "db.example.com",
      port: 6543,
      user: "app",
      password: "s3cr3t",
      database: "main",
      // Slice D. Always stated, never inferred — see the TLS-select cases.
      sslMode: "require",
    });
    wrapper.unmount();
  });

  // The whole point of the parts mode (ADR-0073). Desktop percent-encodes
  // in `composeDsn` because sqlx has no parts-shaped path; web's API takes
  // the fields individually, so the password never passes through a URL
  // parser and there is nothing to encode. Pinned because the tempting
  // "just build the DSN in the browser" refactor would reintroduce exactly
  // the bug the ADR removes.
  it("sends a password containing URL-significant characters untouched", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Awkward");
    await wrapper.find("[data-testid='host-input']").setValue("db.example.com");
    await wrapper.find("[data-testid='password-input']").setValue("p@ss/w#rd?x");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({ password: "p@ss/w#rd?x", host: "db.example.com" }),
    );
    expect(mocks.register.mock.calls[0]![0]).not.toHaveProperty("connectionString");
    wrapper.unmount();
  });

  // ADR-0073 decision 3: a blank port fills in, so the common case is four
  // fields rather than five.
  it("fills in the default port when the port field is left blank", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Local");
    await wrapper.find("[data-testid='host-input']").setValue("localhost");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ port: 5432 }));
    wrapper.unmount();
  });

  it("omits the parts the user left blank rather than sending empty strings", async () => {
    // An empty string is not the same as "not supplied": the resolver
    // treats a supplied-but-empty user or database as a real value and
    // would send it to the server, where it means something different
    // from letting the server apply its own default.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Sparse");
    await wrapper.find("[data-testid='host-input']").setValue("localhost");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    const payload = mocks.register.mock.calls[0]![0];
    expect(payload).not.toHaveProperty("user");
    expect(payload).not.toHaveProperty("password");
    expect(payload).not.toHaveProperty("database");
    wrapper.unmount();
  });

  it("still registers a pasted provider URL through the escape hatch", async () => {
    // Neon, Supabase and Aurora DSQL hand out ready-made URLs. Parts mode
    // is the default; this is the way back out of it.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Neon");
    await wrapper.find("[data-testid='use-url-toggle']").setValue(true);
    await wrapper
      .find("[data-testid='connection-string-input']")
      .setValue("postgres://localhost/db");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledTimes(1);
    expect(mocks.register).toHaveBeenCalledWith({
      label: "Neon",
      driver: "postgres",
      connectionString: "postgres://localhost/db",
      // Slice D. The URL states no mode, so this is the select's own
      // default — and it outranks the URL, which is what makes the select
      // trustworthy in this mode too.
      sslMode: "require",
    });
    wrapper.unmount();
  });

  it("sends only the entry mode that is showing, not both", async () => {
    // Typing a host, switching to URL entry and submitting must not send
    // the abandoned host along with the URL. The API takes the
    // connectionString branch when both are present, so the stray parts
    // would be silently ignored rather than rejected — which is the kind
    // of divergence between what the form shows and what it sends that
    // this rung exists to remove.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Switcher");
    await wrapper.find("[data-testid='host-input']").setValue("abandoned.example.com");
    await wrapper.find("[data-testid='use-url-toggle']").setValue(true);
    await wrapper.find("[data-testid='connection-string-input']").setValue("postgres://real/db");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    const payload = mocks.register.mock.calls[0]![0];
    expect(payload).not.toHaveProperty("host");
    expect(payload.connectionString).toBe("postgres://real/db");
    wrapper.unmount();
  });

  it("asks for no credential at all when the driver needs none", async () => {
    // The null adapter ignores every connection field. Rendering five
    // boxes that do nothing is the same defect ADR-0074 names — offering
    // an input whose effect is nil — one level down from the driver list.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='driver-input']").setValue("null");
    await flushPromises();

    expect(wrapper.find("[data-testid='host-input']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='use-url-toggle']").exists()).toBe(false);

    await wrapper.find("[data-testid='label-input']").setValue("Fake");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith({ label: "Fake", driver: "null" });
    wrapper.unmount();
  });

  // ---- 0027 slice D: the TLS select ----

  it("defaults the TLS select to required and says so on the wire", async () => {
    // Sent rather than left off. The API defaults to `require` too, so the
    // value is the same either way — but a select that reports a choice it
    // does not transmit is the failure this slice exists to avoid.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    const select = wrapper.find("[data-testid='ssl-mode-input']");
    expect(select.exists()).toBe(true);
    expect((select.element as HTMLSelectElement).value).toBe("require");

    await wrapper.find("[data-testid='label-input']").setValue("Secure");
    await wrapper.find("[data-testid='host-input']").setValue("db.example.com");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ sslMode: "require" }));
    wrapper.unmount();
  });

  it("sends the opt-out when the user picks it", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Local");
    await wrapper.find("[data-testid='host-input']").setValue("localhost");
    await wrapper.find("[data-testid='ssl-mode-input']").setValue("disable");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith(expect.objectContaining({ sslMode: "disable" }));
    wrapper.unmount();
  });

  it("offers the two modes the API accepts and no others", async () => {
    // `prefer` is a 422 as a field. Offering it would be offering a choice
    // that fails on submit — ADR-0074's defect, in a second select.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    const options = wrapper
      .find("[data-testid='ssl-mode-input']")
      .findAll("option")
      .map((o) => o.element.value);
    expect(options).toEqual(["require", "disable"]);
    wrapper.unmount();
  });

  it("keeps the TLS select visible in URL entry mode", async () => {
    // Outside the entry-mode branch: the question "is this encrypted" has
    // an answer in both modes, and it is the same question.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='use-url-toggle']").setValue(true);
    await flushPromises();

    expect(wrapper.find("[data-testid='ssl-mode-input']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("moves the select to match a pasted URL that states a mode", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='use-url-toggle']").setValue(true);
    await wrapper
      .find("[data-testid='connection-string-input']")
      .setValue("postgres://u:p@localhost:5432/db?sslmode=disable");
    await flushPromises();

    const select = wrapper.find("[data-testid='ssl-mode-input']");
    expect((select.element as HTMLSelectElement).value).toBe("disable");

    await wrapper.find("[data-testid='label-input']").setValue("Pasted");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith(
      expect.objectContaining({
        connectionString: "postgres://u:p@localhost:5432/db?sslmode=disable",
        sslMode: "disable",
      }),
    );
    wrapper.unmount();
  });

  it("shows Required for a pasted URL asking for the plaintext fallback", async () => {
    // The API rewrites `prefer` up, so the connection will be encrypted.
    // A select reading Disabled would be describing a different connection
    // from the one about to be made.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='use-url-toggle']").setValue(true);
    await wrapper
      .find("[data-testid='connection-string-input']")
      .setValue("postgres://localhost/db?sslmode=prefer");
    await flushPromises();

    const select = wrapper.find("[data-testid='ssl-mode-input']");
    expect((select.element as HTMLSelectElement).value).toBe("require");
    wrapper.unmount();
  });

  it("leaves a deliberate opt-out alone when the URL states nothing", async () => {
    // A URL with no `sslmode` has no opinion, and overwriting the user's
    // pick with a default they did not choose would be the select changing
    // itself behind them.
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='use-url-toggle']").setValue(true);
    await wrapper.find("[data-testid='ssl-mode-input']").setValue("disable");
    await wrapper
      .find("[data-testid='connection-string-input']")
      .setValue("postgres://localhost/db");
    await flushPromises();

    const select = wrapper.find("[data-testid='ssl-mode-input']");
    expect((select.element as HTMLSelectElement).value).toBe("disable");
    wrapper.unmount();
  });

  it("asks nothing about TLS for a driver that opens no socket", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='driver-input']").setValue("null");
    await flushPromises();

    expect(wrapper.find("[data-testid='ssl-mode-input']").exists()).toBe(false);

    await wrapper.find("[data-testid='label-input']").setValue("Fake");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.register).toHaveBeenCalledWith({ label: "Fake", driver: "null" });
    wrapper.unmount();
  });

  it("calls remove(id) when the per-row delete button is clicked", async () => {
    listRef.value = [{ id: "abc", label: "Prod", driver: "postgres" }];

    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='delete-button']").trigger("click");

    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith("abc");
    wrapper.unmount();
  });

  it("renders the error banner with the i18nKey resolved by the page", async () => {
    lastErrorRef.value = {
      category: "type_conversion",
      message: "cannot convert NaN",
      i18nKey: "error.prefix.type-conversion",
    };

    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    const banner = wrapper.find("[data-testid='error-banner']");
    expect(banner.exists()).toBe(true);
    expect(banner.text()).toContain("error.prefix.type-conversion");
    expect(banner.text()).toContain("cannot convert NaN");
    wrapper.unmount();
  });
  it("offers exactly the drivers the server reports, in that order", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    const options = wrapper.findAll("[data-testid='driver-input'] option");
    expect(options.map((o) => o.attributes("value"))).toEqual(["postgres", "null"]);
    wrapper.unmount();
  });

  it("gains a driver the server gained, with no edit to the template", async () => {
    // The point of the slice. Nothing in the page names `mysql`; it appears
    // because the factory said so.
    driversRef.value = ["postgres", "mysql", "null"];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    const options = wrapper.findAll("[data-testid='driver-input'] option");
    expect(options.map((o) => o.attributes("value"))).toEqual(["postgres", "mysql", "null"]);
    wrapper.unmount();
  });

  it("starts on the first driver the server reports, whatever that is", async () => {
    driversRef.value = ["mysql", "postgres"];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Some DB");
    await wrapper.find("[data-testid='add-form']").trigger("submit");
    await flushPromises();

    expect(mocks.register.mock.calls[0]![0]).toMatchObject({ driver: "mysql" });
    wrapper.unmount();
  });

  it("keeps a driver the user picked when the list arrives late", async () => {
    // The list is fetched, so it can land after the form is interactive.
    // Re-defaulting on arrival would silently undo a deliberate choice.
    driversRef.value = [];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    driversRef.value = ["postgres", "null"];
    await flushPromises();
    await wrapper.find("[data-testid='driver-input']").setValue("null");
    driversRef.value = ["postgres", "null", "mysql"];
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Fake");
    await wrapper.find("[data-testid='add-form']").trigger("submit");
    await flushPromises();

    expect(mocks.register.mock.calls[0]![0]).toMatchObject({ driver: "null" });
    wrapper.unmount();
  });

  it("offers nothing and refuses to submit while no driver list is known", async () => {
    // Better an obviously unusable form than one that looks fine and 404s on
    // submit — the presentation failure ADR-0074 is about.
    driversRef.value = [];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    expect(wrapper.findAll("[data-testid='driver-input'] option")).toHaveLength(0);
    expect(wrapper.find("[data-testid='add-submit']").attributes("disabled")).toBeDefined();

    await wrapper.find("[data-testid='label-input']").setValue("Prod");
    await wrapper.find("[data-testid='add-form']").trigger("submit");
    await flushPromises();

    expect(mocks.register).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  // ---- 0027 slice G: editing a registered connection ----

  it("opens the edit form on the row whose edit button was pressed", async () => {
    listRef.value = [
      { id: "abc", label: "Prod", driver: "postgres", parts: { host: "prod.example.com" } },
      { id: "def", label: "Staging", driver: "postgres", parts: { host: "stg.example.com" } },
    ];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.findAll("[data-testid='edit-button']")[1]!.trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='edit-form']").exists()).toBe(true);
    expect((wrapper.find("[data-testid='host-input']").element as HTMLInputElement).value).toBe(
      "stg.example.com",
    );
    // One form at a time: two sets of the same boxes on one screen is two
    // places to type the answer and one of them is wrong.
    expect(wrapper.find("[data-testid='add-form']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("calls update(id, …) with the driver left off", async () => {
    listRef.value = [
      { id: "abc", label: "Prod", driver: "postgres", parts: { host: "old.example.com" } },
    ];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='edit-button']").trigger("click");
    await flushPromises();
    await wrapper.find("[data-testid='host-input']").setValue("new.example.com");
    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");
    await flushPromises();

    expect(mocks.update).toHaveBeenCalledTimes(1);
    const [id, payload] = mocks.update.mock.calls[0]!;
    expect(id).toBe("abc");
    expect(payload).toMatchObject({ label: "Prod", host: "new.example.com" });
    // `PATCH` has no driver field — the DTO would strip it anyway, and
    // sending one would be claiming an edit can do something it cannot.
    expect(payload).not.toHaveProperty("driver");
    expect(mocks.register).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("closes the edit form once the save goes through", async () => {
    listRef.value = [{ id: "abc", label: "Prod", driver: "postgres", parts: { host: "h" } }];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='edit-button']").trigger("click");
    await flushPromises();
    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");
    await flushPromises();

    expect(wrapper.find("[data-testid='edit-form']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='add-form']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps the edit form open and filled in when the save is refused", async () => {
    // Same reasoning as the add form's reset-on-success: closing here would
    // discard what the user typed at the exact moment they need to fix it.
    listRef.value = [{ id: "abc", label: "Prod", driver: "postgres", parts: { host: "h" } }];
    mocks.update.mockImplementation(() => {
      lastErrorRef.value = {
        category: "connection",
        message: "ECONNREFUSED",
        i18nKey: "error.prefix.connection",
      };
    });
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='edit-button']").trigger("click");
    await flushPromises();
    await wrapper.find("[data-testid='host-input']").setValue("unreachable");
    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");
    await flushPromises();

    expect(wrapper.find("[data-testid='edit-form']").exists()).toBe(true);
    expect((wrapper.find("[data-testid='host-input']").element as HTMLInputElement).value).toBe(
      "unreachable",
    );
    wrapper.unmount();
  });

  it("brings the add form back when the edit is cancelled", async () => {
    listRef.value = [{ id: "abc", label: "Prod", driver: "postgres", parts: { host: "h" } }];
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='edit-button']").trigger("click");
    await flushPromises();
    await wrapper.find("[data-testid='edit-cancel']").trigger("click");
    await flushPromises();

    expect(wrapper.find("[data-testid='edit-form']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='add-form']").exists()).toBe(true);
    expect(mocks.update).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows why the form is empty when the driver list could not be loaded", async () => {
    driversRef.value = [];
    driversErrorRef.value = {
      category: "connection",
      message: "network down",
      i18nKey: "errors.connection",
    };
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    expect(wrapper.find("[data-testid='error-banner']").exists()).toBe(true);
    wrapper.unmount();
  });
});
