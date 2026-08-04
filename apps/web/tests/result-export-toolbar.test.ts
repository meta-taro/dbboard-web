import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ResultExportToolbar from "../app/components/ResultExportToolbar.vue";
import type { QueryResult } from "../app/composables/useQueryExecution";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

const result: QueryResult = {
  columns: [
    { name: "id", declared_type: null },
    { name: "name", declared_type: null },
  ],
  rows: [
    [1, "Alpha"],
    [2, null],
  ],
  rows_affected: 0,
};

function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

describe("ResultExportToolbar", () => {
  beforeEach(() => {
    stubClipboard();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("copies the whole result as TSV", async () => {
    const writeText = stubClipboard();
    const wrapper = mount(ResultExportToolbar, { props: { result } });

    await wrapper.find('[data-testid="result-export__copy"]').trigger("click");
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith("id\tname\n1\tAlpha\n2\t");
    wrapper.unmount();
  });

  it("downloads the whole result as CSV under a stable filename", async () => {
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), {
        createObjectURL: vi.fn(() => "blob:stub"),
        revokeObjectURL: vi.fn(),
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const wrapper = mount(ResultExportToolbar, { props: { result } });

    await wrapper.find('[data-testid="result-export__download"]').trigger("click");

    expect(click).toHaveBeenCalledOnce();
    expect((click.mock.instances[0] as HTMLAnchorElement).download).toBe("dbboard-result.csv");
    wrapper.unmount();
  });

  // Copying gives no visible sign on its own — the page does not change and
  // the clipboard is invisible. Without an acknowledgement the only way to
  // find out whether it worked is to paste somewhere and look.
  it("acknowledges a copy", async () => {
    const wrapper = mount(ResultExportToolbar, { props: { result } });
    expect(wrapper.find('[data-testid="result-export__status"]').text()).toBe("");

    await wrapper.find('[data-testid="result-export__copy"]').trigger("click");
    await Promise.resolve();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="result-export__status"]').text()).toBe(
      "result.export.copied",
    );
    wrapper.unmount();
  });

  it("says so when the clipboard refuses", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    const wrapper = mount(ResultExportToolbar, { props: { result } });

    await wrapper.find('[data-testid="result-export__copy"]').trigger("click");
    await Promise.resolve();
    await wrapper.vm.$nextTick();

    expect(wrapper.find('[data-testid="result-export__status"]').text()).toBe(
      "result.export.failed",
    );
    wrapper.unmount();
  });

  // A screen reader user gets no page change to notice either, so the
  // acknowledgement has to announce itself. The region is rendered from the
  // start, empty: one inserted at the moment its text appears is not reliably
  // announced, because the reader has to be watching it already.
  it("announces the acknowledgement politely", () => {
    const wrapper = mount(ResultExportToolbar, { props: { result } });

    const status = wrapper.find('[data-testid="result-export__status"]');
    expect(status.attributes("role")).toBe("status");
    expect(status.attributes("aria-live")).toBe("polite");
    wrapper.unmount();
  });

  // Both actions serialize a header row, so an empty result still exports
  // something meaningful. Nothing to guard against here — this pins that the
  // buttons stay enabled rather than being disabled on a hunch.
  it("stays usable for a result with no rows", () => {
    const empty: QueryResult = { ...result, rows: [] };
    const wrapper = mount(ResultExportToolbar, { props: { result: empty } });

    expect(
      wrapper.find('[data-testid="result-export__copy"]').attributes("disabled"),
    ).toBeUndefined();
    wrapper.unmount();
  });
});
