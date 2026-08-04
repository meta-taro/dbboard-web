import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextTick } from "vue";
import ThemeSwitcher from "../app/components/ThemeSwitcher.vue";
import { THEME_STORAGE_KEY } from "../app/utils/theme";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

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

function stubMatchMedia(dark: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({
      matches: dark,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

describe("ThemeSwitcher", () => {
  beforeEach(() => {
    stubStorage();
    stubMatchMedia(false);
    document.documentElement.removeAttribute("data-theme");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers the three preferences, auto first", () => {
    const wrapper = mount(ThemeSwitcher);

    const options = wrapper.findAll("option").map((o) => o.attributes("value"));
    expect(options).toEqual(["auto", "light", "dark"]);
    wrapper.unmount();
  });

  // The stored value is read in onMounted, not during setup, so that
  // server-rendered markup and the first client render agree. The correction
  // therefore lands one tick later.
  it("shows the stored preference as selected", async () => {
    stubStorage({ [THEME_STORAGE_KEY]: "dark" });
    const wrapper = mount(ThemeSwitcher);
    await nextTick();

    expect((wrapper.find("select").element as HTMLSelectElement).value).toBe("dark");
    wrapper.unmount();
  });

  it("applies and persists the chosen preference", async () => {
    const storage = stubStorage();
    const wrapper = mount(ThemeSwitcher);

    await wrapper.find("select").setValue("dark");

    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(storage.setItem).toHaveBeenCalledWith(THEME_STORAGE_KEY, "dark");
    wrapper.unmount();
  });

  // Anything else on the origin can write this key, and the <select> would
  // otherwise show a blank value for it.
  it("ignores a value that is not one of the three", async () => {
    const wrapper = mount(ThemeSwitcher);

    await wrapper.find("select").setValue("solarized");

    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    wrapper.unmount();
  });

  // Colour alone is never the indicator (DESIGN.md, accessibility).
  it("labels itself through i18n rather than an icon alone", () => {
    const wrapper = mount(ThemeSwitcher);

    expect(wrapper.text()).toContain("theme-switcher.label");
    const optionText = wrapper.findAll("option").map((o) => o.text());
    expect(optionText).toEqual([
      "theme-switcher.option.auto",
      "theme-switcher.option.light",
      "theme-switcher.option.dark",
    ]);
    wrapper.unmount();
  });
});
