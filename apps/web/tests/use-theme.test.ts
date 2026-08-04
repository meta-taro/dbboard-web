import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { useTheme } from "../app/composables/useTheme";
import { THEME_STORAGE_KEY } from "../app/utils/theme";

// The impure half of desktop ADR-0041: storage, the OS media query, and the
// attribute on <html>. The three-way preference itself is covered by
// theme.test.ts; what is tested here is that none of these three can break the
// page — ADR-0041 makes loading non-fatal because "UI chrome must not be able
// to block startup", and on the web every one of them can fail or lie.

type ThemeApi = ReturnType<typeof useTheme>;

function makeHarness() {
  const holder: { api: ThemeApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useTheme();
      return () => h("div");
    },
  });
  return { Component, holder };
}

/**
 * An in-memory `localStorage`.
 *
 * The test environment's own `window.localStorage` is an empty object here
 * (Node's experimental Web Storage global shadows happy-dom's implementation
 * and is inert without `--localstorage-file`), so relying on it would test
 * nothing. Supplying the store also lets the failure cases below throw on
 * demand, which is the behaviour that actually matters.
 */
function stubStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  const store = {
    getItem: vi.fn((k: string) => map.get(k) ?? null),
    setItem: vi.fn((k: string, v: string) => {
      map.set(k, v);
    }),
    removeItem: vi.fn((k: string) => {
      map.delete(k);
    }),
    clear: vi.fn(() => map.clear()),
    key: vi.fn((i: number) => [...map.keys()][i] ?? null),
    get length() {
      return map.size;
    },
  };
  vi.stubGlobal("localStorage", store);
  return store;
}

/** A matchMedia stub whose `matches` the test can flip, as the OS would. */
function stubMatchMedia(initialDark: boolean) {
  const listeners = new Set<(e: MediaQueryListEvent) => void>();
  const mql = {
    matches: initialDark,
    media: "(prefers-color-scheme: dark)",
    addEventListener: vi.fn((_: string, l: (e: MediaQueryListEvent) => void) => {
      listeners.add(l);
    }),
    removeEventListener: vi.fn((_: string, l: (e: MediaQueryListEvent) => void) => {
      listeners.delete(l);
    }),
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => mql),
  );
  return {
    mql,
    flip(dark: boolean) {
      mql.matches = dark;
      for (const l of listeners) l({ matches: dark } as MediaQueryListEvent);
    },
    listenerCount: () => listeners.size,
  };
}

function themeAttr(): string | null {
  return document.documentElement.getAttribute("data-theme");
}

describe("useTheme", () => {
  beforeEach(() => {
    stubStorage();
    document.documentElement.removeAttribute("data-theme");
    stubMatchMedia(false);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("with nothing stored, sits on auto and sets no attribute", () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(holder.api!.preference.value).toBe("auto");
    expect(themeAttr()).toBeNull();
    wrapper.unmount();
  });

  it("applies a stored preference on mount", () => {
    stubStorage({ [THEME_STORAGE_KEY]: "dark" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(holder.api!.preference.value).toBe("dark");
    expect(themeAttr()).toBe("dark");
    wrapper.unmount();
  });

  it("a malformed stored value is indistinguishable from no preference", () => {
    stubStorage({ [THEME_STORAGE_KEY]: '{"theme":"dark"}' });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(holder.api!.preference.value).toBe("auto");
    expect(themeAttr()).toBeNull();
    wrapper.unmount();
  });

  // Safari in private mode throws on both read and write rather than returning
  // null. A theme switcher is not worth a blank page.
  it("survives storage that throws on read", () => {
    stubStorage().getItem.mockImplementation(() => {
      throw new DOMException("denied", "SecurityError");
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(holder.api!.preference.value).toBe("auto");
    wrapper.unmount();
  });

  it("survives storage that throws on write, and still applies the choice", async () => {
    stubStorage().setItem.mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    holder.api!.setPreference("dark");
    await nextTick();

    expect(holder.api!.preference.value).toBe("dark");
    expect(themeAttr()).toBe("dark");
    wrapper.unmount();
  });

  it("setPreference persists the choice and moves the attribute", async () => {
    const storage = stubStorage();
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    holder.api!.setPreference("light");
    await nextTick();
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("light");
    expect(themeAttr()).toBe("light");

    holder.api!.setPreference("dark");
    await nextTick();
    expect(themeAttr()).toBe("dark");
    wrapper.unmount();
  });

  // Invariant 5 of ticket 0025: choosing auto must leave the page in the same
  // state as never having chosen anything, so the media query alone decides.
  it("going back to auto removes the attribute again", async () => {
    const storage = stubStorage({ [THEME_STORAGE_KEY]: "dark" });
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    expect(themeAttr()).toBe("dark");

    holder.api!.setPreference("auto");
    await nextTick();

    expect(themeAttr()).toBeNull();
    expect(storage.getItem(THEME_STORAGE_KEY)).toBe("auto");
    wrapper.unmount();
  });

  it("resolved follows the OS while on auto, and stops once a choice is made", async () => {
    const media = stubMatchMedia(true);
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(holder.api!.resolved.value).toBe("dark");

    media.flip(false);
    await nextTick();
    expect(holder.api!.resolved.value).toBe("light");

    holder.api!.setPreference("dark");
    media.flip(false);
    await nextTick();
    expect(holder.api!.resolved.value).toBe("dark");
    wrapper.unmount();
  });

  it("detaches the media listener on unmount", () => {
    const media = stubMatchMedia(false);
    const { Component } = makeHarness();
    const wrapper = mount(Component);
    expect(media.listenerCount()).toBe(1);

    wrapper.unmount();

    expect(media.listenerCount()).toBe(0);
  });

  // Older Safari exposes only the deprecated addListener/removeListener pair.
  it("does not throw when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    expect(holder.api!.resolved.value).toBe("light");
    wrapper.unmount();
  });
});
