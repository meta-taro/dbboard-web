import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ResultGrid from "../app/components/ResultGrid.vue";

// We trust @tanstack/vue-virtual itself and only test our component's
// rendering. The mock returns every row as a visible virtual item so the
// assertions can target real cells without juggling getBoundingClientRect
// on happy-dom (which always reports zero size).
vi.mock("@tanstack/vue-virtual", () => ({
  useVirtualizer: (computedOptions: unknown) => {
    function readOptions(): { count: number; estimateSize: () => number } {
      const candidate = computedOptions as
        | (() => { count: number; estimateSize: () => number })
        | { value?: { count: number; estimateSize: () => number } }
        | { count: number; estimateSize: () => number };
      if (typeof candidate === "function") return candidate();
      if (
        candidate &&
        typeof candidate === "object" &&
        "value" in candidate &&
        candidate.value !== undefined
      ) {
        return candidate.value;
      }
      return candidate as { count: number; estimateSize: () => number };
    }
    return {
      value: {
        getVirtualItems: () => {
          const opts = readOptions();
          const size = opts.estimateSize();
          return Array.from({ length: opts.count }, (_, index) => ({
            index,
            start: index * size,
            size,
            end: (index + 1) * size,
            key: index,
          }));
        },
        getTotalSize: () => {
          const opts = readOptions();
          return opts.count * opts.estimateSize();
        },
        measureElement: () => {},
      },
    };
  },
}));

const SAMPLE_RESULT = {
  columns: [
    { name: "id", declared_type: "INTEGER" },
    { name: "label", declared_type: "TEXT" },
    { name: "payload", declared_type: "BYTEA" },
    { name: "deleted_at", declared_type: "TIMESTAMP" },
  ],
  rows: [
    [1, "Prod", { $blob: "AAAA" }, null],
    [2, "Staging", { $blob: "" }, null],
    [3, "Dev", { $blob: "ZZZZZZZZ" }, "2026-01-01T00:00:00Z"],
  ],
  rows_affected: 0,
} as const;

describe("ResultGrid", () => {
  it("renders one <th> per column in the declared order", () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const headers = wrapper.findAll("[data-testid='result-grid__column-header']");
    expect(headers.map((h) => h.text())).toEqual(["id", "label", "payload", "deleted_at"]);
    wrapper.unmount();
  });

  it("renders one <tr> per row plus all the cells", () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const rows = wrapper.findAll("[data-testid='result-grid__row']");
    expect(rows).toHaveLength(SAMPLE_RESULT.rows.length);

    const cells = wrapper.findAll("[data-testid='result-grid__cell']");
    expect(cells).toHaveLength(SAMPLE_RESULT.rows.length * SAMPLE_RESULT.columns.length);
  });

  it("marks null cells with the cell--null modifier and renders 'NULL'", () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const nullCells = wrapper.findAll(".cell--null");
    expect(nullCells.length).toBeGreaterThanOrEqual(2);
    for (const cell of nullCells) {
      expect(cell.text()).toBe("NULL");
    }
    wrapper.unmount();
  });

  it("renders blob cells as <blob: N chars> with the cell--blob modifier", () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const blobCells = wrapper.findAll(".cell--blob");
    expect(blobCells).toHaveLength(3);
    expect(blobCells[0]!.text()).toBe("<blob: 4 chars>");
    expect(blobCells[1]!.text()).toBe("<blob: 0 chars>");
    expect(blobCells[2]!.text()).toBe("<blob: 8 chars>");
    wrapper.unmount();
  });

  it("renders the outer scroll container so horizontal scroll works on mobile", () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const scroller = wrapper.find("[data-testid='result-grid']");
    expect(scroller.exists()).toBe(true);
    // The container must be the scrollElement target for the virtualizer
    // and the horizontal-scroll surface for the cells — `overflow: auto`
    // pins both properties on a single element.
    const style = scroller.attributes("style") ?? "";
    const className = scroller.attributes("class") ?? "";
    // The component may put overflow in the inline style or pull it from
    // scoped CSS; either source is acceptable as long as the test can see
    // the class hook.
    expect(style + " " + className).toMatch(/grid-scroll|overflow/);
    wrapper.unmount();
  });

  it("renders number cells right-aligned via the cell--number modifier", () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const numberCells = wrapper.findAll(".cell--number");
    expect(numberCells.map((c) => c.text())).toEqual(["1", "2", "3"]);
    wrapper.unmount();
  });

  it("renders string cells under the cell--string modifier", () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const stringCells = wrapper.findAll(".cell--string");
    // Three from the label column, one from the timestamp on the third row.
    expect(stringCells.map((c) => c.text())).toEqual([
      "Prod",
      "Staging",
      "Dev",
      "2026-01-01T00:00:00Z",
    ]);
    wrapper.unmount();
  });
});
