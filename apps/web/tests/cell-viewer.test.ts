import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CellViewer from "../app/components/CellViewer.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

const LONG = "x".repeat(200);

describe("CellViewer", () => {
  beforeEach(() => {
    stubClipboard();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("names the column the value came from", () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    expect(wrapper.find('[data-testid="cell-viewer__column"]').text()).toBe("payload");
    wrapper.unmount();
  });

  // The whole point of the viewer: what the cell truncated is readable here,
  // in full and unmodified.
  it("renders the value whole", () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    expect(wrapper.find('[data-testid="cell-viewer__body"]').text()).toBe(LONG);
    wrapper.unmount();
  });

  // A cell renders on one line however many the value has. Collapsing them
  // again here would leave nowhere to see the shape of the data.
  it("keeps the line breaks of a multi-line value", () => {
    const wrapper = mount(CellViewer, { props: { column: "note", value: "one\ntwo" } });

    const body = wrapper.find('[data-testid="cell-viewer__body"]');
    expect(body.element.tagName).toBe("PRE");
    expect(body.text()).toContain("one\ntwo");
    wrapper.unmount();
  });

  it("copies the value, not what is on screen", async () => {
    const writeText = stubClipboard();
    const wrapper = mount(CellViewer, { props: { column: "note", value: "one\ntwo" } });

    await wrapper.find('[data-testid="cell-viewer__copy"]').trigger("click");
    expect(writeText).toHaveBeenCalledWith("one\ntwo");
    wrapper.unmount();
  });

  it("acknowledges a copy", async () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });
    expect(wrapper.find('[data-testid="cell-viewer__status"]').text()).toBe("");

    await wrapper.find('[data-testid="cell-viewer__copy"]').trigger("click");
    await Promise.resolve();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="cell-viewer__status"]').text()).toBe("result.viewer.copied");
    wrapper.unmount();
  });

  it("says so when the clipboard refuses", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    await wrapper.find('[data-testid="cell-viewer__copy"]').trigger("click");
    await Promise.resolve();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="cell-viewer__status"]').text()).toBe("result.viewer.failed");
    wrapper.unmount();
  });

  it("is a labelled modal dialog", () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.attributes("aria-modal")).toBe("true");
    expect(dialog.attributes("aria-label")).toBe("result.viewer.label");
    wrapper.unmount();
  });

  it("closes on Escape", async () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    await wrapper.find('[data-testid="cell-viewer"]').trigger("keydown", { key: "Escape" });
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  it("closes when the backdrop is clicked", async () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    await wrapper.find('[data-testid="cell-viewer"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });

  // Selecting text inside the dialog means dragging across it, and a click
  // that bubbles out of the panel would close the thing being read.
  it("stays open when the panel itself is clicked", async () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    await wrapper.find('[role="dialog"]').trigger("click");
    expect(wrapper.emitted("close")).toBeUndefined();
    wrapper.unmount();
  });

  // Escape is not available on a phone, and a backdrop nobody knows to tap
  // is not a way out.
  it("offers a close button", async () => {
    const wrapper = mount(CellViewer, { props: { column: "payload", value: LONG } });

    await wrapper.find('[data-testid="cell-viewer__close"]').trigger("click");
    expect(wrapper.emitted("close")).toHaveLength(1);
    wrapper.unmount();
  });
});
