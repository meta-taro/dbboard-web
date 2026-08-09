import { mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ref, type Ref } from "vue";
import ConnectionForm from "../app/components/ConnectionForm.vue";
import type { CategorisedError } from "../app/composables/useConnections";

// Same reason as the page test: vue-i18n needs a configured instance under a
// real Nuxt runtime, and this file runs in plain happy-dom. The copy itself
// is verified by tests/i18n-locale-parity.test.ts.
vi.mock("vue-i18n", () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// The Fetch button dials a bastion (ADR-0076), which is HTTP and therefore
// not this file's subject. Its own tests live in use-ssh-host-key.test.ts;
// here the composable is a stub so the button's *wiring* can be asserted.
const probe = vi.hoisted(() => vi.fn());
let probeError: Ref<CategorisedError | null>;
let probeState: Ref<"idle" | "probing" | "error">;

vi.mock("../app/composables/useSshHostKey", () => ({
  useSshHostKey: () => ({
    fingerprint: ref(null),
    lastError: probeError,
    state: probeState,
    probe,
    reset: vi.fn(),
  }),
}));

// `turso` earns its place here: it is a driver the server offers and a tunnel
// cannot front, so it is what the bastion section has to stay away from.
const DRIVERS = ["postgres", "null", "turso"];

// The one literal the PII scanner's allowlist knows, so a key-shaped fixture
// does not have to look like a real key to be treated as one.
const PEM = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

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

// A connection the server reported as running behind a bastion. No credential
// in it, because `SshParts` has none to report — `auth` names the kind.
const TUNNELLED = {
  id: "t",
  label: "Behind",
  driver: "postgres",
  parts: { host: "db.internal", port: 5432, user: "app" },
  ssh: {
    host: "bastion.example.com",
    port: 2222,
    user: "deploy",
    auth: "private-key" as const,
    hostKey: { kind: "fingerprint" as const, fingerprint: "SHA256:stored" },
  },
};

function mountForm(props: Record<string, unknown>) {
  return mount(ConnectionForm, { props: { drivers: DRIVERS, ...props } });
}

function inputIds(wrapper: ReturnType<typeof mountForm>): string[] {
  return wrapper
    .findAll("[data-testid]")
    .map((el) => el.attributes("data-testid")!)
    .filter((id) => id.endsWith("-input") || id === "use-url-toggle" || id === "ssh-toggle")
    .sort();
}

function submitted(wrapper: ReturnType<typeof mountForm>): Record<string, unknown> {
  return wrapper.emitted("submit")![0]![0] as Record<string, unknown>;
}

beforeEach(() => {
  probe.mockReset();
  probeError = ref(null);
  probeState = ref("idle");
});

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

describe("ConnectionForm — the bastion in front of the database", () => {
  it("does not offer a tunnel to a driver that cannot be fronted by one", () => {
    // Turso is a libSQL URL, not a `host:port` pair, so there is nothing for a
    // forward to redirect and the API answers a block on it with a 404. The
    // form asks the same table `StaticAdapterFactory` does.
    const wrapper = mountForm({
      mode: "edit",
      initial: { id: "z", label: "Edge", driver: "turso", parts: { host: "db.turso.io" } },
    });

    expect(wrapper.find("[data-testid='ssh-toggle']").exists()).toBe(false);
    // Still a real connection with real credentials — only the bastion is out.
    expect(wrapper.find("[data-testid='host-input']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("keeps the bastion boxes out of the way until the tunnel is switched on", () => {
    const wrapper = mountForm({ mode: "add" });

    expect(wrapper.find("[data-testid='ssh-toggle']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='ssh-host-input']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("says nothing about ssh when the tunnel was never switched on", async () => {
    // Not `ssh: null`. On a registration the two would behave alike, but this
    // form emits one payload shape for both modes, and on an edit `null` is an
    // instruction to take a bastion away.
    const wrapper = mountForm({ mode: "add" });

    await wrapper.find("[data-testid='label-input']").setValue("Direct");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");

    expect(submitted(wrapper)).not.toHaveProperty("ssh");
    wrapper.unmount();
  });

  it("emits the bastion as a nested block", async () => {
    // Nested, because `SshTunnelDto` is validated with `@ValidateNested()`
    // under a whitelist: flattened `sshHost`/`sshUser` would be stripped at the
    // pipe and the connection registered going direct.
    const wrapper = mountForm({ mode: "add" });

    await wrapper.find("[data-testid='label-input']").setValue("Tunnelled");
    await wrapper.find("[data-testid='ssh-toggle']").setValue(true);
    await wrapper.find("[data-testid='ssh-host-input']").setValue("bastion.example.com");
    await wrapper.find("[data-testid='ssh-user-input']").setValue("deploy");
    await wrapper.find("[data-testid='ssh-private-key-input']").setValue(PEM);
    await wrapper.find("[data-testid='ssh-fingerprint-input']").setValue("SHA256:abc");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");

    expect(submitted(wrapper).ssh).toEqual({
      host: "bastion.example.com",
      // No `port`. Blank means 22, and `ProbeSshHostKey` and the tunnel both
      // resolve that server-side — a copy here could drift from the port the
      // forward actually dials.
      user: "deploy",
      privateKey: PEM,
      fingerprint: "SHA256:abc",
    });
    wrapper.unmount();
  });

  it("sends a password instead of a key when that is how the bastion is entered", async () => {
    const wrapper = mountForm({ mode: "add" });

    await wrapper.find("[data-testid='label-input']").setValue("Tunnelled");
    await wrapper.find("[data-testid='ssh-toggle']").setValue(true);
    await wrapper.find("[data-testid='ssh-auth-input']").setValue("password");
    await wrapper.find("[data-testid='ssh-host-input']").setValue("bastion.example.com");
    await wrapper.find("[data-testid='ssh-user-input']").setValue("deploy");
    await wrapper.find("[data-testid='ssh-password-input']").setValue("hunter2");
    await wrapper.find("[data-testid='ssh-fingerprint-input']").setValue("SHA256:abc");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");

    // Exactly one credential reaches the wire. Two would be refused as
    // ambiguous, and the box that is not on screen must not contribute one.
    expect(wrapper.find("[data-testid='ssh-private-key-input']").exists()).toBe(false);
    expect(submitted(wrapper).ssh).toEqual({
      host: "bastion.example.com",
      user: "deploy",
      password: "hunter2",
      fingerprint: "SHA256:abc",
    });
    wrapper.unmount();
  });

  it("sends a known_hosts entry instead of a fingerprint when that is the pin", async () => {
    const wrapper = mountForm({ mode: "add" });

    await wrapper.find("[data-testid='label-input']").setValue("Tunnelled");
    await wrapper.find("[data-testid='ssh-toggle']").setValue(true);
    await wrapper.find("[data-testid='ssh-host-key-input']").setValue("known-hosts");
    await wrapper.find("[data-testid='ssh-host-input']").setValue("bastion.example.com");
    await wrapper.find("[data-testid='ssh-user-input']").setValue("deploy");
    await wrapper.find("[data-testid='ssh-private-key-input']").setValue(PEM);
    await wrapper
      .find("[data-testid='ssh-known-hosts-input']")
      .setValue("bastion.example.com ssh-ed25519 AAAA");
    await wrapper.find("[data-testid='add-form']").trigger("submit.prevent");

    // Nothing to fetch when the pin is a file's worth of entries, so the
    // button that fetches one is not offered either.
    expect(wrapper.find("[data-testid='ssh-fetch-host-key']").exists()).toBe(false);
    expect(submitted(wrapper).ssh).toEqual({
      host: "bastion.example.com",
      user: "deploy",
      privateKey: PEM,
      knownHosts: "bastion.example.com ssh-ed25519 AAAA",
    });
    wrapper.unmount();
  });

  it("opens an edit on the bastion the server reported, with the credential box blank", () => {
    const wrapper = mountForm({ mode: "edit", initial: TUNNELLED });

    const value = (id: string) =>
      (wrapper.find(`[data-testid='${id}']`).element as HTMLInputElement).value;

    expect((wrapper.find("[data-testid='ssh-toggle']").element as HTMLInputElement).checked).toBe(
      true,
    );
    expect(value("ssh-host-input")).toBe("bastion.example.com");
    expect(value("ssh-port-input")).toBe("2222");
    expect(value("ssh-user-input")).toBe("deploy");
    expect(value("ssh-auth-input")).toBe("private-key");
    expect(value("ssh-host-key-input")).toBe("fingerprint");
    // The host key is not a secret and identifies what is being trusted, so
    // it comes back and is shown; the key that opens the bastion does not.
    expect(value("ssh-fingerprint-input")).toBe("SHA256:stored");
    expect(value("ssh-private-key-input")).toBe("");
    expect(wrapper.find("[data-testid='ssh-secret-keep-hint']").exists()).toBe(true);
    wrapper.unmount();
  });

  it("re-submits a blank credential as nothing, which the server reads as keep", async () => {
    const wrapper = mountForm({ mode: "edit", initial: TUNNELLED });

    await wrapper.find("[data-testid='ssh-port-input']").setValue("2223");
    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");

    // The point of the whole carry rule (ADR-0080, reaching the bastion):
    // changing a port must not tear down a working tunnel.
    expect(submitted(wrapper).ssh).toEqual({
      host: "bastion.example.com",
      port: 2223,
      user: "deploy",
      fingerprint: "SHA256:stored",
    });
    wrapper.unmount();
  });

  it("emits an explicit null when a bastion is switched off on an edit", async () => {
    // Absence already means "keep the tunnel you are on", so removal has no
    // other spelling. A form that emitted nothing here would leave the
    // connection permanently behind its bastion.
    const wrapper = mountForm({ mode: "edit", initial: TUNNELLED });

    await wrapper.find("[data-testid='ssh-toggle']").setValue(false);
    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");

    expect(submitted(wrapper).ssh).toBeNull();
    wrapper.unmount();
  });

  it("keeps a tunnel it has no boxes for rather than taking it away", async () => {
    // The server can offer a driver this build has no row for, and it may
    // already be behind a bastion. Hiding the section must not read as
    // switching the tunnel off: absent keeps it, and the operator can still
    // rename the connection from a build that cannot render its tunnel.
    const wrapper = mountForm({
      mode: "edit",
      initial: { ...TUNNELLED, driver: "cockroach" },
    });

    await wrapper.find("[data-testid='edit-form']").trigger("submit.prevent");

    expect(wrapper.find("[data-testid='ssh-toggle']").exists()).toBe(false);
    expect(submitted(wrapper)).not.toHaveProperty("ssh");
    wrapper.unmount();
  });

  it("dials nothing until the Fetch button is pressed", async () => {
    const wrapper = mountForm({ mode: "add" });

    await wrapper.find("[data-testid='ssh-toggle']").setValue(true);
    await wrapper.find("[data-testid='ssh-host-input']").setValue("bastion.example.com");

    // ADR-0076. Probing while the host box is still being typed in would
    // connect to whatever prefix happened to resolve.
    expect(probe).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("fills the fingerprint box with what the bastion presented", async () => {
    probe.mockResolvedValueOnce("SHA256:fetched");
    const wrapper = mountForm({ mode: "add" });

    await wrapper.find("[data-testid='ssh-toggle']").setValue(true);
    await wrapper.find("[data-testid='ssh-host-input']").setValue("bastion.example.com");
    await wrapper.find("[data-testid='ssh-port-input']").setValue("2222");
    await wrapper.find("[data-testid='ssh-fetch-host-key']").trigger("click");
    await Promise.resolve();
    await wrapper.vm.$nextTick();

    expect(probe).toHaveBeenCalledWith("bastion.example.com", 2222);
    expect(
      (wrapper.find("[data-testid='ssh-fingerprint-input']").element as HTMLInputElement).value,
    ).toBe("SHA256:fetched");
    wrapper.unmount();
  });

  it("leaves the fingerprint box alone when the probe is refused", async () => {
    probe.mockResolvedValueOnce(null);
    const wrapper = mountForm({ mode: "edit", initial: TUNNELLED });

    await wrapper.find("[data-testid='ssh-fetch-host-key']").trigger("click");
    probeError.value = {
      category: "connection",
      message: "ECONNREFUSED",
      i18nKey: "error.prefix.connection",
    };
    await wrapper.vm.$nextTick();

    // The stored pin survives a failed probe: overwriting it with nothing
    // would turn a network blip into an unverified bastion.
    expect(
      (wrapper.find("[data-testid='ssh-fingerprint-input']").element as HTMLInputElement).value,
    ).toBe("SHA256:stored");
    expect(wrapper.find("[data-testid='ssh-probe-error']").exists()).toBe(true);
    wrapper.unmount();
  });
});
