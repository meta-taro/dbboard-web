import { mount } from "@vue/test-utils";
import { describe, expect, it, vi } from "vitest";
import ResultGrid from "../app/components/ResultGrid.vue";

vi.mock("vue-i18n", () => ({
  useI18n: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}|${JSON.stringify(params)}` : key,
  }),
}));

// See tests/helpers/virtualizer.ts — every row is rendered, because the real
// virtualizer measures nothing on happy-dom.
vi.mock("@tanstack/vue-virtual", async () => ({
  useVirtualizer: (await import("./helpers/virtualizer")).fakeUseVirtualizer,
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

  it("sorts the display on a header click, leaving the result untouched", async () => {
    const before = JSON.stringify(SAMPLE_RESULT.rows);
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const headers = wrapper.findAll("[data-testid='result-grid__sort-button']");
    expect(headers).toHaveLength(SAMPLE_RESULT.columns.length);
    // ids are already 1, 2, 3 — the second click (descending) is the one
    // that proves the display actually reorders.
    await headers[0]!.trigger("click");
    await headers[0]!.trigger("click");

    expect(wrapper.findAll(".cell--number").map((c) => c.text())).toEqual(["3", "2", "1"]);
    expect(JSON.stringify(SAMPLE_RESULT.rows)).toBe(before);
    wrapper.unmount();
  });

  it("keeps each row addressable by its real index while sorted", async () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const byLabel = wrapper.findAll("[data-testid='result-grid__sort-button']")[1]!;
    await byLabel.trigger("click"); // Dev, Prod, Staging

    const rows = wrapper.findAll("[data-testid='result-grid__row']");
    expect(rows.map((r) => r.attributes("data-row-index"))).toEqual(["2", "0", "1"]);
    wrapper.unmount();
  });

  it("cycles a column ascending, descending, then back to natural order", async () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const byLabel = wrapper.findAll("[data-testid='result-grid__sort-button']")[1]!;
    const labels = () =>
      wrapper
        .findAll("[data-testid='result-grid__row']")
        .map((r) => r.attributes("data-row-index"));

    await byLabel.trigger("click");
    expect(labels()).toEqual(["2", "0", "1"]);
    await byLabel.trigger("click");
    expect(labels()).toEqual(["1", "0", "2"]);
    await byLabel.trigger("click");
    expect(labels()).toEqual(["0", "1", "2"]);
    wrapper.unmount();
  });

  it("reports the sort state on the header cell, not just as a glyph", async () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const sortState = () =>
      wrapper
        .findAll("[data-testid='result-grid__column-header']")
        .map((h) => h.attributes("aria-sort"));
    expect(sortState()).toEqual(["none", "none", "none", "none"]);

    await wrapper.findAll("[data-testid='result-grid__sort-button']")[1]!.trigger("click");
    expect(sortState()).toEqual(["none", "ascending", "none", "none"]);
    await wrapper.findAll("[data-testid='result-grid__sort-button']")[1]!.trigger("click");
    expect(sortState()).toEqual(["none", "descending", "none", "none"]);
    wrapper.unmount();
  });

  it("numbers the levels only once more than one column sorts", async () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    const buttons = wrapper.findAll("[data-testid='result-grid__sort-button']");
    const glyphs = () =>
      wrapper.findAll("[data-testid='result-grid__sort-indicator']").map((g) => g.text());

    await buttons[0]!.trigger("click");
    // A lone sort level needs no number — the arrow says everything.
    expect(glyphs()).toEqual(["▲"]);

    await buttons[1]!.trigger("click", { ctrlKey: true });
    expect(glyphs()).toEqual(["▲1", "▲2"]);
    wrapper.unmount();
  });

  it("drops the sort when a different result is rendered", async () => {
    const wrapper = mount(ResultGrid, { props: { result: SAMPLE_RESULT } });

    await wrapper.findAll("[data-testid='result-grid__sort-button']")[0]!.trigger("click");
    await wrapper.findAll("[data-testid='result-grid__sort-button']")[0]!.trigger("click");
    expect(wrapper.findAll(".cell--number").map((c) => c.text())).toEqual(["3", "2", "1"]);

    await wrapper.setProps({
      result: {
        columns: [{ name: "n", declared_type: "INTEGER" }],
        rows: [[7], [4]],
        rows_affected: 0,
      },
    });
    expect(wrapper.findAll(".cell--number").map((c) => c.text())).toEqual(["7", "4"]);
    expect(
      wrapper
        .findAll("[data-testid='result-grid__column-header']")
        .map((h) => h.attributes("aria-sort")),
    ).toEqual(["none"]);
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

// Desktop ADR-0082 decision 5: a value the cell could not show in full opens
// a viewer, and "in full" is measured in display columns.
const LONG = "x".repeat(200);
const VIEWER_RESULT = {
  columns: [
    { name: "note", declared_type: "TEXT" },
    { name: "short", declared_type: "TEXT" },
    { name: "empty", declared_type: "TEXT" },
    { name: "bytes", declared_type: "BYTEA" },
  ],
  rows: [
    [LONG, "ok", null, { $blob: "A".repeat(500) }],
    ["one\ntwo", "ok", null, { $blob: "" }],
  ],
  rows_affected: 0,
} as const;

function cellAt(wrapper: ReturnType<typeof mount>, row: number, column: number) {
  const cells = wrapper.findAll("[data-testid='result-grid__cell']");
  return cells[row * VIEWER_RESULT.columns.length + column]!;
}

describe("ResultGrid — cell viewer", () => {
  it("opens the viewer on a value too wide for its cell", async () => {
    const wrapper = mount(ResultGrid, { props: { result: VIEWER_RESULT } });
    expect(wrapper.find("[data-testid='cell-viewer']").exists()).toBe(false);

    await cellAt(wrapper, 0, 0).trigger("dblclick");

    expect(wrapper.find("[data-testid='cell-viewer']").exists()).toBe(true);
    expect(wrapper.find("[data-testid='cell-viewer__column']").text()).toBe("note");
    expect(wrapper.find("[data-testid='cell-viewer__body']").text()).toBe(LONG);
    wrapper.unmount();
  });

  it("leaves a value that fits alone", async () => {
    const wrapper = mount(ResultGrid, { props: { result: VIEWER_RESULT } });

    await cellAt(wrapper, 0, 1).trigger("dblclick");

    expect(wrapper.find("[data-testid='cell-viewer']").exists()).toBe(false);
    wrapper.unmount();
  });

  // Short, but the cell renders it on one line — the second line is not
  // visible anywhere until the value is opened.
  it("opens the viewer on a multi-line value however short", async () => {
    const wrapper = mount(ResultGrid, { props: { result: VIEWER_RESULT } });

    await cellAt(wrapper, 1, 0).trigger("dblclick");

    expect(wrapper.find("[data-testid='cell-viewer__body']").text()).toContain("one\ntwo");
    wrapper.unmount();
  });

  it("never opens the viewer on NULL", async () => {
    const wrapper = mount(ResultGrid, { props: { result: VIEWER_RESULT } });

    await cellAt(wrapper, 0, 2).trigger("dblclick");

    expect(wrapper.find("[data-testid='cell-viewer']").exists()).toBe(false);
    wrapper.unmount();
  });

  // A blob cell shows `<blob: N chars>`, and that placeholder is all the
  // viewer would have to show — the bytes are not in the result.
  //
  // Worth knowing about this case and the NULL one above: both would also
  // pass with the value guard removed, because those two placeholders are
  // short enough that the width test rejects them anyway. They pin the
  // behaviour, not the branch. The branch is still worth having — see the
  // comment on `openViewer`.
  it("never opens the viewer on a blob, however large", async () => {
    const wrapper = mount(ResultGrid, { props: { result: VIEWER_RESULT } });

    await cellAt(wrapper, 0, 3).trigger("dblclick");

    expect(wrapper.find("[data-testid='cell-viewer']").exists()).toBe(false);
    wrapper.unmount();
  });

  it("closes the viewer when it asks to be closed", async () => {
    const wrapper = mount(ResultGrid, { props: { result: VIEWER_RESULT } });
    await cellAt(wrapper, 0, 0).trigger("dblclick");

    await wrapper.find("[data-testid='cell-viewer__close']").trigger("click");

    expect(wrapper.find("[data-testid='cell-viewer']").exists()).toBe(false);
    wrapper.unmount();
  });

  // The viewer is keyed on the row it was opened from, and sorting moves
  // rows. Reading a value that belongs to a different row than the one
  // clicked would be worse than not opening at all.
  it("opens the value of the row actually clicked while sorted", async () => {
    const wrapper = mount(ResultGrid, { props: { result: VIEWER_RESULT } });

    // Ascending on `note` sorts "one\ntwo" before "xxx…", so display row 0
    // is real row 1 — the one ordering where the two indices disagree.
    const byNote = wrapper.findAll("[data-testid='result-grid__sort-button']")[0]!;
    await byNote.trigger("click");
    expect(
      wrapper
        .findAll("[data-testid='result-grid__row']")
        .map((r) => r.attributes("data-row-index")),
    ).toEqual(["1", "0"]);

    await cellAt(wrapper, 0, 0).trigger("dblclick");
    expect(wrapper.find("[data-testid='cell-viewer__body']").text()).toContain("one\ntwo");

    await wrapper.find("[data-testid='cell-viewer__close']").trigger("click");
    await cellAt(wrapper, 1, 0).trigger("dblclick");
    expect(wrapper.find("[data-testid='cell-viewer__body']").text()).toBe(LONG);
    wrapper.unmount();
  });
});
