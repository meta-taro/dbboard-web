import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ConnectionForm from "../app/components/ConnectionForm.vue";

// Same reason as the page test: vue-i18n needs a configured instance under a
// real Nuxt runtime, and this file runs in plain happy-dom. The copy itself
// is verified by tests/i18n-locale-parity.test.ts.
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

const DRIVERS = ["postgres", "null"];

const EXISTING = {
  id: "abc",
  label: "Prod",
  driver: "postgres",
  parts: {
    host: "db.example.com",
    port: 6543,
    user: "app",
    database: "main",
    sslMode: "disable" as const,
  },
};

function mountForm(props: Record<string, unknown>) {
  return mount(ConnectionForm, { props: { drivers: DRIVERS, ...props } });
}

function inputIds(wrapper: ReturnType<typeof mountForm>): string[] {
  return wrapper
    .findAll("[data-testid]")
    .map((el) => el.attributes("data-testid")!)
    .filter((id) => id.endsWith("-input") || id === "use-url-toggle")
    .sort();
}

describe("ConnectionForm", () => {
  // The acceptance criterion of 0027 slice G, pinned as an assertion rather
  // than left to inspection: editing a connection asks the same questions
  // registering one does. A second, drifting copy of the form would satisfy
  // the words and lose the point.
  it("renders the same inputs in edit mode as in add mode, less the driver", () => {
    const add = mountForm({ mode: "add" });
    const edit = mountForm({ mode: "edit", initial: EXISTING });

    // The driver is the one field an edit cannot change: swapping it under a
    // live id would keep the label while changing what the connection is.
    expect(inputIds(edit)).toEqual(inputIds(add).filter((id) => id !== "driver-input"));

    add.unmount();
    edit.unmount();
  });

  it("opens an edit with the parts the server sent", () => {
    // ADR-0080 decision 5. The backend sent parts, so the form opens in parts
    // mode showing them — not an empty form the user has to re-type.
    const wrapper = mountForm({ mode: "edit", initial: EXISTING });

    const value = (id: string) =>
      (wrapper.find(`[data-testid='${id}']`).element as HTMLInputElement).value;

    expect(value("label-input")).toBe("Prod");
    expect(value("host-input")).toBe("db.example.com");
    expect(value("port-input")).toBe("6543");
    expect(value("user-input")).toBe("app");
    expect(value("database-input")).toBe("main");
    expect(value("ssl-mode-input")).toBe("disable");
    expect(wrapper.find("[data-testid='use-url-toggle']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='connection-string-input']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("shows the driver it cannot change rather than hiding it", () => {
    const wrapper = mountForm({ mode: "edit", initial: EXISTING });

    expect(wrapper.find("[data-testid='driver-input']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='driver-fixed']").text()).toBe("postgres");
    wrapper.unmount();
  });

  it("starts the password box blank and says what blank will do", () => {
    // The API never sends a password back, so there is nothing to prefill —
    // and a blank box that silently removed the credential would be the worst
    // reading of the same emptiness. It means keep (ADR-0080).
    const wrapper = mountForm({ mode: "edit", initial: EXISTING });

    const box = wrapper.find("[data-testid='password-input']").element as HTMLInputElement;
    expect(box.value).toBe("");
    expect(wrapper.find("[data-testid='password-keep-hint']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("emits the edited connection, and no password, when the box is left blank", async () => {
    const wrapper = mountForm({ mode: "edit", initial: EXISTING });

    await wrapper.find("[data-testid='host-input']").setValue("new.example.com");
    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");

    const payload = wrapper.emitted("submit")![0]![0] as Record<string, unknown>;
    expect(payload).toMatchObject({
      label: "Prod",
      // Carried through so the page can address the right record; the page is
      // what drops it, because `PATCH` has no business receiving it.
      driver: "postgres",
      host: "new.example.com",
      port: 6543,
      user: "app",
      database: "main",
      sslMode: "disable",
    });
    // Absent rather than empty: both mean keep on the server, and sending
    // nothing is the honest spelling of "the user said nothing about it".
    expect(payload).not.toHaveProperty("password");
    wrapper.unmount();
  });

  it("emits a typed password when the user replaces the credential", async () => {
    const wrapper = mountForm({ mode: "edit", initial: EXISTING });

    await wrapper.find("[data-testid='password-input']").setValue("n3w-s3cr3t");
    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");

    expect(wrapper.emitted("submit")![0]![0]).toMatchObject({ password: "n3w-s3cr3t" });
    wrapper.unmount();
  });

  it("emits cancel without emitting a submit", async () => {
    const wrapper = mountForm({ mode: "edit", initial: EXISTING });

    await wrapper.find("[data-testid='edit-cancel']").trigger("click");

    expect(wrapper.emitted("cancel")).toHaveLength(1);
    expect(wrapper.emitted("submit")).toBeUndefined();
    wrapper.unmount();
  });

  it("offers no credential boxes for a connection whose driver opens no socket", () => {
    const wrapper = mountForm({
      mode: "edit",
      initial: { id: "z", label: "Fake", driver: "null" },
    });

    expect(wrapper.find("[data-testid='host-input']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='ssl-mode-input']").exists()).toBe(false);
    expect(wrapper.find("[data-testid='label-input']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("defaults an edit with no stored TLS mode to required", () => {
    // Same reasoning as registration: the select states the connection that
    // is about to be made, and `require` is what the API would apply.
    const wrapper = mountForm({
      mode: "edit",
      initial: { id: "z", label: "Old", driver: "postgres", parts: { host: "h" } },
    });

    const select = wrapper.find("[data-testid='ssl-mode-input']").element as HTMLSelectElement;
    expect(select.value).toBe("require");
    wrapper.unmount();
  });

  it("still emits a registration payload in add mode", async () => {
    const wrapper = mountForm({ mode: "add" });

    await wrapper.find("[data-testid='label-input']").setValue("Neon");
    await wrapper.find("[data-testid='host-input']").setValue("db.example.com");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");

    expect(wrapper.emitted("submit")![0]![0]).toEqual({
      label: "Neon",
      driver: "postgres",
      host: "db.example.com",
      port: 5432,
      sslMode: "require",
    });
    expect(wrapper.find("[data-testid='edit-cancel']").exists()).toBe(false);
    wrapper.unmount();
  });
});
