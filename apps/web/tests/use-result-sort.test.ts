import { describe, expect, it } from "vitest";
import { ref } from "vue";
import type { QueryResult, Value } from "../app/composables/useQueryExecution";
import { useResultSort } from "../app/composables/useResultSort";

function makeResult(rows: Value[][]): QueryResult {
  return {
    columns: [
      { name: "team", declared_type: "text" },
      { name: "score", declared_type: "integer" },
    ],
    rows,
    rows_affected: 0,
  };
}

// team / score, deliberately out of order in both columns.
const SAMPLE = makeResult([
  ["b", 2],
  ["a", 9],
  ["a", 1],
]);

describe("useResultSort", () => {
  it("leaves rows in their natural order until a header is clicked", () => {
    const { order, keys } = useResultSort(ref(SAMPLE));
    expect(order.value).toEqual([0, 1, 2]);
    expect(keys.value).toEqual([]);
  });

  it("reorders on a header click, as indices into the untouched rows", () => {
    const result = ref(SAMPLE);
    // Sorting must not touch the rows themselves — rung 6 will stage edits
    // keyed on the real row index, and a sorted-in-place array remaps them.
    const before = JSON.stringify(result.value.rows);
    const { order, toggle } = useResultSort(result);
    toggle(1, false);
    expect(order.value).toEqual([2, 0, 1]);
    expect(JSON.stringify(result.value.rows)).toBe(before);
  });

  it("cycles one column ascending, descending, off", () => {
    const { order, toggle } = useResultSort(ref(SAMPLE));
    toggle(1, false);
    expect(order.value).toEqual([2, 0, 1]);
    toggle(1, false);
    expect(order.value).toEqual([1, 0, 2]);
    toggle(1, false);
    expect(order.value).toEqual([0, 1, 2]);
  });

  it("builds a multi-level sort and reports each column's level", () => {
    const { order, toggle, indicator } = useResultSort(ref(SAMPLE));
    toggle(0, false);
    toggle(1, true);
    expect(order.value).toEqual([2, 1, 0]);
    expect(indicator(0)).toEqual({ level: 1, ascending: true });
    expect(indicator(1)).toEqual({ level: 2, ascending: true });
  });

  it("reports nothing for a column that does not sort", () => {
    const { toggle, indicator } = useResultSort(ref(SAMPLE));
    expect(indicator(0)).toBeNull();
    toggle(1, false);
    expect(indicator(0)).toBeNull();
  });

  // A fresh result may have entirely different columns, so a sort on
  // "column 1" would silently start meaning something else.
  it("drops the sort when a new result arrives", async () => {
    const result = ref(SAMPLE);
    const { order, keys, toggle } = useResultSort(result);
    toggle(1, false);
    expect(keys.value).toHaveLength(1);
    result.value = makeResult([
      ["z", 3],
      ["y", 1],
    ]);
    await Promise.resolve();
    expect(keys.value).toEqual([]);
    expect(order.value).toEqual([0, 1]);
  });
});
