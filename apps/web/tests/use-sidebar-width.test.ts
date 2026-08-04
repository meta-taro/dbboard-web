import { mount } from "@vue/test-utils";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import { useSidebarWidth } from "../app/composables/useSidebarWidth";
import {
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MIN_WIDTH,
  SIDEBAR_NUDGE,
  SIDEBAR_WIDTH_STORAGE_KEY,
} from "../app/utils/splitter";

// The impure half of desktop ADR-0083: storage, `window.innerWidth`, and the
// resize listener. The sizing rules themselves are covered by splitter.test.ts.
// What is tested here is decision 3 — the chosen width survives a window too
// narrow to honour it — and that none of the three can break the page.

type SidebarApi = ReturnType<typeof useSidebarWidth>;

function makeHarness() {
  const holder: { api: SidebarApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useSidebarWidth();
      return () => h("div");
    },
  });
  return { Component, holder };
}

/** See use-theme.test.ts: the environment's own `localStorage` is inert here. */
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

function stubViewport(width: number) {
  vi.stubGlobal("innerWidth", width);
}

/** Resize the window as the browser would, listener and all. */
async function resizeTo(width: number) {
  vi.stubGlobal("innerWidth", width);
  window.dispatchEvent(new Event("resize"));
  await nextTick();
}

async function mountWith(initial: Record<string, string> = {}, viewport = 1440) {
  const store = stubStorage(initial);
  stubViewport(viewport);
  const { Component, holder } = makeHarness();
  const wrapper = mount(Component);
  await nextTick();
  return { store, wrapper, api: holder.api! };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useSidebarWidth", () => {
  it("starts at the default when nothing is stored", async () => {
    const { api } = await mountWith();

    expect(api.width.value).toBe(SIDEBAR_DEFAULT_WIDTH);
  });

  it("restores a stored width", async () => {
    const { api } = await mountWith({ [SIDEBAR_WIDTH_STORAGE_KEY]: "360" });

    expect(api.width.value).toBe(360);
  });

  it("persists a width the user drags to", async () => {
    const { api, store } = await mountWith();

    api.setWidth(360);
    await nextTick();

    expect(api.width.value).toBe(360);
    expect(store.setItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_STORAGE_KEY, "360");
  });

  // ADR-0083 decision 3. Clamping on write would have quietly destroyed the
  // preference the moment someone dragged the window narrow.
  it("squeezes the sidebar on a narrow window but remembers the choice", async () => {
    const { api } = await mountWith({ [SIDEBAR_WIDTH_STORAGE_KEY]: "600" });

    expect(api.width.value).toBe(600);

    await resizeTo(900);
    expect(api.width.value).toBe(450);

    await resizeTo(1600);
    expect(api.width.value).toBe(600);
  });

  it("still gives the sidebar its minimum on a window too narrow for both panes", async () => {
    const { api } = await mountWith({ [SIDEBAR_WIDTH_STORAGE_KEY]: "600" });

    await resizeTo(200);

    expect(api.width.value).toBe(SIDEBAR_MIN_WIDTH);
  });

  describe("nudge", () => {
    it("moves one step per press, in both directions", async () => {
      const { api } = await mountWith({ [SIDEBAR_WIDTH_STORAGE_KEY]: "320" });

      api.nudge(SIDEBAR_NUDGE);
      await nextTick();
      expect(api.width.value).toBe(320 + SIDEBAR_NUDGE);

      api.nudge(-SIDEBAR_NUDGE);
      await nextTick();
      expect(api.width.value).toBe(320);
    });

    it("persists each step, so a keyboard drag survives a reload", async () => {
      const { api, store } = await mountWith({ [SIDEBAR_WIDTH_STORAGE_KEY]: "320" });

      api.nudge(SIDEBAR_NUDGE);

      expect(store.setItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_STORAGE_KEY, "336");
    });

    // Nudging from the squeezed width, not from the remembered one: the
    // divider has to move away from where it is drawn, or the first press
    // appears to do nothing.
    it("steps from the width on screen, not the one in storage", async () => {
      const { api } = await mountWith({ [SIDEBAR_WIDTH_STORAGE_KEY]: "600" });
      await resizeTo(900);

      api.nudge(-SIDEBAR_NUDGE);
      await nextTick();

      expect(api.width.value).toBe(450 - SIDEBAR_NUDGE);
    });
  });

  describe("reset", () => {
    // ADR-0083 decision 2: resetting the position but leaving the preference
    // behind would be a lie the next reload exposes.
    it("returns to the default and forgets the stored width", async () => {
      const { api, store } = await mountWith({ [SIDEBAR_WIDTH_STORAGE_KEY]: "600" });

      api.reset();
      await nextTick();

      expect(api.width.value).toBe(SIDEBAR_DEFAULT_WIDTH);
      expect(store.removeItem).toHaveBeenCalledWith(SIDEBAR_WIDTH_STORAGE_KEY);
      expect(store.setItem).not.toHaveBeenCalled();
    });
  });

  // Ticket 0025 invariant 6, inherited from ADR-0041: UI chrome must not be
  // able to block startup. Safari private mode throws on read and on write.
  describe("when storage is unusable", () => {
    it("renders at the default rather than failing", async () => {
      vi.stubGlobal("localStorage", {
        getItem: () => {
          throw new Error("SecurityError");
        },
      });
      stubViewport(1440);
      const { Component, holder } = makeHarness();

      expect(() => mount(Component)).not.toThrow();
      await nextTick();
      expect(holder.api!.width.value).toBe(SIDEBAR_DEFAULT_WIDTH);
    });

    it("keeps a failed write from undoing the drag", async () => {
      const store = stubStorage();
      store.setItem.mockImplementation(() => {
        throw new Error("QuotaExceededError");
      });
      stubViewport(1440);
      const { Component, holder } = makeHarness();
      mount(Component);
      await nextTick();

      expect(() => holder.api!.setWidth(360)).not.toThrow();
      await nextTick();
      expect(holder.api!.width.value).toBe(360);
    });
  });

  it("stops listening for resizes once unmounted", async () => {
    const { wrapper, api } = await mountWith();
    const before = api.width.value;

    wrapper.unmount();
    await resizeTo(300);

    expect(api.width.value).toBe(before);
  });
});
