import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import SidebarSplitter from "../app/components/SidebarSplitter.vue";
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, SIDEBAR_NUDGE } from "../app/utils/splitter";

vi.mock("vue-i18n", () => ({ useI18n: () => ({ t: (key: string) => key }) }));

function mountSplitter(width = 280) {
  const wrapper = mount(SidebarSplitter, { props: { width } });
  const el = wrapper.element as HTMLElement;
  // Pointer capture is not implemented in happy-dom, and is missing from some
  // embedded WebViews too — which is why the component calls it defensively.
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.assign(el, { setPointerCapture, releasePointerCapture });
  return { wrapper, setPointerCapture, releasePointerCapture };
}

/** Press, move, and (unless told otherwise) release — one mouse drag. */
async function drag(
  wrapper: ReturnType<typeof mountSplitter>["wrapper"],
  from: number,
  to: number,
  { release = true } = {},
) {
  await wrapper.trigger("pointerdown", { clientX: from, pointerId: 1, button: 0 });
  await wrapper.trigger("pointermove", { clientX: to, pointerId: 1 });
  if (release) await wrapper.trigger("pointerup", { clientX: to, pointerId: 1 });
}

function resizes(wrapper: ReturnType<typeof mountSplitter>["wrapper"]): number[] {
  return (wrapper.emitted("resize") ?? []).map((args) => (args as [number])[0]);
}

function nudges(wrapper: ReturnType<typeof mountSplitter>["wrapper"]): number[] {
  return (wrapper.emitted("nudge") ?? []).map((args) => (args as [number])[0]);
}

describe("SidebarSplitter", () => {
  // ADR-0083 decision 5: a drag handle reachable only by mouse is not a
  // control. A focusable window splitter is the sanctioned use of the role.
  it("is a focusable separator", () => {
    const { wrapper } = mountSplitter();

    expect(wrapper.attributes("role")).toBe("separator");
    expect(wrapper.attributes("aria-orientation")).toBe("vertical");
    expect(wrapper.attributes("tabindex")).toBe("0");
    expect(wrapper.attributes("aria-label")).toBeTruthy();
  });

  it("reports where it sits, and how far it can go", async () => {
    const { wrapper } = mountSplitter(320);

    expect(wrapper.attributes("aria-valuenow")).toBe("320");
    expect(wrapper.attributes("aria-valuemin")).toBe(String(SIDEBAR_MIN_WIDTH));
    expect(wrapper.attributes("aria-valuemax")).toBe(String(SIDEBAR_MAX_WIDTH));

    await wrapper.setProps({ width: 360 });
    expect(wrapper.attributes("aria-valuenow")).toBe("360");
  });

  describe("dragging", () => {
    // The sidebar sits to the *right* of the divider on this page, so moving
    // the pointer left makes it wider. Desktop's sidebar is on the left and
    // reads the opposite way; the sign lives here rather than in the caller.
    it("widens the sidebar as the pointer moves left", async () => {
      const { wrapper } = mountSplitter(280);

      await drag(wrapper, 800, 760);

      expect(resizes(wrapper)).toEqual([320]);
    });

    it("narrows it as the pointer moves right", async () => {
      const { wrapper } = mountSplitter(280);

      await drag(wrapper, 800, 840);

      expect(resizes(wrapper)).toEqual([240]);
    });

    // Every move is measured from where the press landed, not from the last
    // move: accumulating deltas drifts, and the divider ends up lagging the
    // pointer by however many events were coalesced.
    it("measures each move from where the press landed", async () => {
      const { wrapper } = mountSplitter(280);

      await wrapper.trigger("pointerdown", { clientX: 800, pointerId: 1, button: 0 });
      await wrapper.trigger("pointermove", { clientX: 780, pointerId: 1 });
      await wrapper.trigger("pointermove", { clientX: 760, pointerId: 1 });

      expect(resizes(wrapper)).toEqual([300, 320]);
    });

    it("ignores a pointer that is merely passing over it", async () => {
      const { wrapper } = mountSplitter();

      await wrapper.trigger("pointermove", { clientX: 760, pointerId: 1 });

      expect(wrapper.emitted("resize")).toBeUndefined();
    });

    it("stops following the pointer once released", async () => {
      const { wrapper } = mountSplitter(280);

      await drag(wrapper, 800, 760);
      await wrapper.trigger("pointermove", { clientX: 600, pointerId: 1 });

      expect(resizes(wrapper)).toEqual([320]);
    });

    it("stops following when the drag is cancelled", async () => {
      const { wrapper } = mountSplitter(280);

      await wrapper.trigger("pointerdown", { clientX: 800, pointerId: 1, button: 0 });
      await wrapper.trigger("pointercancel", { pointerId: 1 });
      await wrapper.trigger("pointermove", { clientX: 600, pointerId: 1 });

      expect(wrapper.emitted("resize")).toBeUndefined();
    });

    // ADR-0083 decision 5. The pointer always outruns a handle this narrow,
    // and without capture the drag dies the moment it does.
    it("captures the pointer for the length of the drag", async () => {
      const { wrapper, setPointerCapture, releasePointerCapture } = mountSplitter();

      await wrapper.trigger("pointerdown", { clientX: 800, pointerId: 7, button: 0 });
      expect(setPointerCapture).toHaveBeenCalledWith(7);
      expect(releasePointerCapture).not.toHaveBeenCalled();

      await wrapper.trigger("pointerup", { clientX: 760, pointerId: 7 });
      expect(releasePointerCapture).toHaveBeenCalledWith(7);
    });

    // A right-click opens a context menu; starting a drag under it strands
    // the divider with no pointerup to end it.
    it("does not start on a non-primary button", async () => {
      const { wrapper, setPointerCapture } = mountSplitter();

      await wrapper.trigger("pointerdown", { clientX: 800, pointerId: 1, button: 2 });
      await wrapper.trigger("pointermove", { clientX: 760, pointerId: 1 });

      expect(setPointerCapture).not.toHaveBeenCalled();
      expect(wrapper.emitted("resize")).toBeUndefined();
    });
  });

  describe("keyboard", () => {
    it("nudges wider with the left arrow and narrower with the right", async () => {
      const { wrapper } = mountSplitter(280);

      await wrapper.trigger("keydown", { key: "ArrowLeft" });
      await wrapper.trigger("keydown", { key: "ArrowRight" });

      expect(nudges(wrapper)).toEqual([SIDEBAR_NUDGE, -SIDEBAR_NUDGE]);
    });

    it("resets on Home", async () => {
      const { wrapper } = mountSplitter(600);

      await wrapper.trigger("keydown", { key: "Home" });

      expect(wrapper.emitted("reset")).toHaveLength(1);
    });

    // Tab has to keep moving focus, and every other key belongs to whatever
    // handles it next.
    it("leaves keys it does not handle to the page", async () => {
      const { wrapper } = mountSplitter();

      await wrapper.trigger("keydown", { key: "Tab" });
      await wrapper.trigger("keydown", { key: "a" });

      expect(wrapper.emitted("nudge")).toBeUndefined();
      expect(wrapper.emitted("reset")).toBeUndefined();
    });
  });

  // ADR-0083 decision 2, from the mouse side.
  it("resets on a double-click", async () => {
    const { wrapper } = mountSplitter(600);

    await wrapper.trigger("dblclick");

    expect(wrapper.emitted("reset")).toHaveLength(1);
  });
});
