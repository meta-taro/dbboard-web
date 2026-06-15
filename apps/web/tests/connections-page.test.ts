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

  it("calls register() with the form payload when the add form submits", async () => {
    const wrapper = mount(ConnectionsPage, mountOptions);
    await flushPromises();

    await wrapper.find("[data-testid='label-input']").setValue("Neon");
    await wrapper.find("[data-testid='driver-input']").setValue("postgres");
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
