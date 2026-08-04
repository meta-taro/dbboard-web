import { mount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent, h, nextTick } from "vue";
import type { Column, Value } from "../app/composables/useQueryExecution";
import { useResultExport } from "../app/composables/useResultExport";
import { UTF8_BOM } from "../app/utils/export";

// The I/O half of slice B. Serialization is covered by export.test.ts; what is
// tested here is that neither half can take the page down with it. The
// clipboard is absent outside a secure context and rejects when the permission
// is denied, and both are ordinary states on a page whose whole job is to
// still be usable afterwards.

type ExportApi = ReturnType<typeof useResultExport>;

function makeHarness() {
  const holder: { api: ExportApi | null } = { api: null };
  const Component = defineComponent({
    setup() {
      holder.api = useResultExport();
      return () => h("div");
    },
  });
  return { Component, holder };
}

const columns: Column[] = [
  { name: "id", declared_type: null },
  { name: "name", declared_type: null },
];
const rows: Value[][] = [[1, "Alpha"]];

function stubClipboard(writeText = vi.fn().mockResolvedValue(undefined)) {
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

describe("useResultExport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    stubClipboard();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("copies the result as TSV, without a byte-order mark", async () => {
    const writeText = stubClipboard();
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.copyTsv(columns, rows);

    expect(writeText).toHaveBeenCalledWith("id\tname\n1\tAlpha");
    expect(writeText.mock.calls[0]![0].startsWith(UTF8_BOM)).toBe(false);
    expect(holder.api!.state.value).toBe("copied");
    wrapper.unmount();
  });

  it("reports a rejected clipboard write instead of throwing", async () => {
    stubClipboard(vi.fn().mockRejectedValue(new DOMException("denied", "NotAllowedError")));
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await expect(holder.api!.copyTsv(columns, rows)).resolves.toBeUndefined();

    expect(holder.api!.state.value).toBe("failed");
    wrapper.unmount();
  });

  // navigator.clipboard is undefined over plain http, which is how someone
  // running the API on a LAN box will first meet this button.
  it("reports a missing clipboard API instead of throwing", async () => {
    vi.stubGlobal("navigator", {});
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.copyTsv(columns, rows);

    expect(holder.api!.state.value).toBe("failed");
    wrapper.unmount();
  });

  it("clears the confirmation after a moment", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    await holder.api!.copyTsv(columns, rows);
    expect(holder.api!.state.value).toBe("copied");

    vi.runAllTimers();
    await nextTick();

    expect(holder.api!.state.value).toBe("idle");
    wrapper.unmount();
  });

  // A timer that fires into a torn-down component writes to a ref nothing owns
  // any more; Vue warns, and under a route change it is a leak.
  it("cancels a pending confirmation on unmount", async () => {
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);
    await holder.api!.copyTsv(columns, rows);

    wrapper.unmount();
    vi.runAllTimers();

    expect(holder.api!.state.value).toBe("copied");
  });

  it("downloads CSV with the byte-order mark and revokes the object URL", async () => {
    const created: Blob[] = [];
    vi.stubGlobal(
      "URL",
      Object.assign(Object.create(URL), {
        createObjectURL: vi.fn((blob: Blob) => {
          created.push(blob);
          return "blob:stub";
        }),
        revokeObjectURL: vi.fn(),
      }),
    );
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const { Component, holder } = makeHarness();
    const wrapper = mount(Component);

    holder.api!.downloadCsv(columns, rows, "result.csv");

    expect(click).toHaveBeenCalledOnce();
    const anchor = click.mock.instances[0] as HTMLAnchorElement;
    expect(anchor.download).toBe("result.csv");
    expect(anchor.href).toContain("blob:stub");
    expect(await created[0]!.text()).toBe(`${UTF8_BOM}id,name\r\n1,Alpha`);
    expect(created[0]!.type).toContain("text/csv");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:stub");
    // The anchor is a means, not content: it must not survive the click.
    expect(document.querySelector("a[download]")).toBeNull();
    wrapper.unmount();
  });
});
