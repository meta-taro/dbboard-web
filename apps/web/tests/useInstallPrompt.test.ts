import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { useInstallPrompt } from "../app/composables/useInstallPrompt";

// Vue Test Utils unwraps refs through wrapper.vm. Stash the raw composable
// return value on a non-reactive holder so the test can read .value directly
// and observe the reactive surface as callers would.
type InstallPromptApi = ReturnType<typeof useInstallPrompt>;

function makeHarness() {
  const holder: { api: InstallPromptApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useInstallPrompt();
      return () => h("div");
    },
  });
  return { Component, holder };
}

interface UserChoice {
  outcome: "accepted" | "dismissed";
  platform: string;
}

function fireBeforeInstallPrompt(userChoice: UserChoice) {
  const event = new Event("beforeinstallprompt") as Event & {
    platforms: ReadonlyArray<string>;
    userChoice: Promise<UserChoice>;
    prompt: () => Promise<void>;
  };
  Object.assign(event, {
    platforms: ["web"],
    userChoice: Promise.resolve(userChoice),
    prompt: vi.fn().mockResolvedValue(undefined),
  });
  window.dispatchEvent(event);
  return event;
}

describe("useInstallPrompt", () => {
  afterEach(() => {
    // Each test gets a clean window — strip any leftover listeners.
    vi.restoreAllMocks();
  });

  it("starts with canInstall=false before beforeinstallprompt fires", () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    const api = holder.api!;
    expect(api.canInstall.value).toBe(false);
    expect(api.installed.value).toBe(false);
    wrapper.unmount();
  });

  it("captures the event and exposes canInstall=true", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    const api = holder.api!;

    fireBeforeInstallPrompt({ outcome: "accepted", platform: "web" });
    await nextTick();

    expect(api.canInstall.value).toBe(true);
    wrapper.unmount();
  });

  it("prompt() resolves with the user's choice and clears the deferred event", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    const api = holder.api!;
    const event = fireBeforeInstallPrompt({
      outcome: "accepted",
      platform: "web",
    });
    await nextTick();

    const outcome = await api.prompt();

    expect(event.prompt).toHaveBeenCalledTimes(1);
    expect(outcome).toBe("accepted");
    expect(api.lastOutcome.value).toBe("accepted");
    // Spec says the event is single-use.
    expect(api.canInstall.value).toBe(false);
    wrapper.unmount();
  });

  it("prompt() returns 'unavailable' when no event was captured", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    const api = holder.api!;

    const outcome = await api.prompt();

    expect(outcome).toBe("unavailable");
    expect(api.lastOutcome.value).toBe("unavailable");
    wrapper.unmount();
  });

  it("flips installed=true and canInstall=false on appinstalled", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    const api = holder.api!;
    fireBeforeInstallPrompt({ outcome: "accepted", platform: "web" });
    await nextTick();
    expect(api.canInstall.value).toBe(true);

    window.dispatchEvent(new Event("appinstalled"));
    await nextTick();

    expect(api.installed.value).toBe(true);
    expect(api.canInstall.value).toBe(false);
    wrapper.unmount();
  });
});
