/**
 * Reactive half of result-grid sorting: the active sort keys, the display
 * permutation, and the per-column header indicator. The ordering itself is
 * pure and lives in `~/utils/sort`.
 *
 * Desktop (ADR-0048) caches the permutation behind a `dirty` flag and
 * recomputes it in `order_for`. Here a `computed` is that cache — it
 * invalidates when the keys or the result change and at no other time — so
 * the flag has no counterpart.
 */
import { computed, ref, toValue, watch, type MaybeRefOrGetter, type Ref } from "vue";
import type { QueryResult } from "./useQueryExecution";
import { nextSortKeys, sortedRowOrder, type SortKey } from "../utils/sort";

export interface SortIndicator {
  /** 1-based position among the sort keys, for the header badge. */
  level: number;
  ascending: boolean;
}

export interface UseResultSort {
  keys: Ref<SortKey[]>;
  /** Display order: a permutation of row indices, never reordered rows. */
  order: Readonly<Ref<number[]>>;
  toggle: (column: number, additive: boolean) => void;
  indicator: (column: number) => SortIndicator | null;
}

export function useResultSort(result: MaybeRefOrGetter<QueryResult>): UseResultSort {
  const keys = ref<SortKey[]>([]);

  // A fresh result may have entirely different columns, so a key naming
  // "column 1" would quietly start meaning something else. Watching the
  // result's identity rather than its row count also covers a re-run that
  // happens to return the same number of rows.
  watch(
    () => toValue(result),
    () => {
      keys.value = [];
    },
  );

  const order = computed(() => sortedRowOrder(toValue(result).rows, keys.value));

  function toggle(column: number, additive: boolean): void {
    keys.value = nextSortKeys(keys.value, column, additive);
  }

  function indicator(column: number): SortIndicator | null {
    const index = keys.value.findIndex((key) => key.column === column);
    if (index === -1) return null;
    return { level: index + 1, ascending: (keys.value[index] as SortKey).ascending };
  }

  return { keys, order, toggle, indicator };
}
