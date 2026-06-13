<script setup lang="ts">
// Virtualised SQL result grid for the Phase 4 SQL editor page.
//
// Uses @tanstack/vue-virtual for vertical row virtualisation so that the
// worst-case 10,000-row payload (ROW_CAP in 0005) renders in O(viewport)
// DOM nodes. Cell typing comes from app/utils/format-value.ts — the grid
// just maps `kind` to a BEM modifier so SQL-aware styling (right-aligned
// numbers, monospace blobs, dimmed nulls) stays in CSS.
//
// The "NULL" and "<blob: N chars>" literals are SQL/technical, not
// user-facing copy — they are intentionally NOT routed through vue-i18n.

import { computed, ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import type { QueryResult } from "../composables/useQueryExecution";
import { formatValue } from "../utils/format-value";

const props = defineProps<{ result: QueryResult }>();

const scrollerRef = ref<HTMLElement | null>(null);

const ROW_HEIGHT_PX = 36;

const virtualizer = useVirtualizer(
  computed(() => ({
    count: props.result.rows.length,
    getScrollElement: () => scrollerRef.value,
    estimateSize: () => ROW_HEIGHT_PX,
    overscan: 8,
  })),
);

const totalHeight = computed(() => virtualizer.value.getTotalSize());
const virtualRows = computed(() => virtualizer.value.getVirtualItems());

function cellFor(rowIndex: number, columnIndex: number) {
  const row = props.result.rows[rowIndex];
  return formatValue(row ? (row[columnIndex] ?? null) : null);
}
</script>

<template>
  <div ref="scrollerRef" data-testid="result-grid" class="grid-scroll">
    <table class="grid">
      <thead>
        <tr>
          <th
            v-for="column in result.columns"
            :key="column.name"
            data-testid="result-grid__column-header"
            class="header-cell"
            scope="col"
          >
            {{ column.name }}
          </th>
        </tr>
      </thead>
      <tbody :style="{ height: `${totalHeight}px`, position: 'relative' }">
        <tr
          v-for="vRow in virtualRows"
          :key="vRow.index"
          data-testid="result-grid__row"
          class="row"
          :style="{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            transform: `translateY(${vRow.start}px)`,
            height: `${vRow.size}px`,
          }"
        >
          <td
            v-for="(column, columnIndex) in result.columns"
            :key="column.name"
            data-testid="result-grid__cell"
            class="cell"
            :class="`cell--${cellFor(vRow.index, columnIndex).kind}`"
          >
            {{ cellFor(vRow.index, columnIndex).text }}
          </td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.grid-scroll {
  /* The virtualizer needs a scrollable element with a stable height —
     a fixed clamp keeps the row pool small on mobile (375 × 667) while
     desktop still gets a comfortable viewport. */
  max-height: 60vh;
  min-height: 240px;
  overflow: auto;
  border: 1px solid var(--border, #e3e6ea);
  border-radius: 4px;
  background: var(--surface, #ffffff);
}

.grid {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-size: 0.9rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.header-cell {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0.5rem 0.75rem;
  text-align: left;
  background: var(--surface-muted, #f5f6f8);
  border-bottom: 1px solid var(--border, #e3e6ea);
  font-weight: 600;
  white-space: nowrap;
}

.row {
  display: flex;
}

.cell {
  flex: 1 1 0;
  min-width: 96px;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--border-faint, #eef1f4);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell--null {
  color: var(--text-muted, #94a0ad);
  font-style: italic;
}

.cell--number {
  text-align: right;
  font-variant-numeric: tabular-nums;
}

.cell--string {
  text-align: left;
}

.cell--blob {
  color: var(--text-muted, #5a6573);
  font-style: italic;
}
</style>
