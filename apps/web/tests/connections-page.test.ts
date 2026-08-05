import { mount, flushPromises } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";
import ConnectionsPage from "../app/pages/connections/index.vue";

// vi.hoisted runs before imports so the mock factory below can safely close
// over `mocks.register/remove/refresh`. The reactive refs themselves are
// re-created per-test in beforeEach so each test starts on a clean slate.
const mocks = vi.hoisted(() => ({
  register: vi.fn(),
  remove: vi.fn(),
  refresh: vi.fn(),
}));

let listRef: Ref<Array<{ id: string; label: string; driver: string }>>;
let stateRef: Ref<"idle" | "loading" | "error">;
let lastErrorRef: Ref<{ category: string; message: string; i18nKey: string } | null>;

vi.mock("../app/composables/useConnections", () => ({
  useConnections: () => ({
    list: listRef,
    state: stateRef,
    lastError: lastErrorRef,
    register: mocks.register,
    remove: mocks.remove,
    refresh: mocks.refresh,
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
    stateRef = ref<"idle" | "loading" | "error">("idle");
    lastErrorRef = ref<{
      category: string;
      message: string;
      i18nKey: string;
    } | null>(null);
    mocks.register.mockReset();
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
});
