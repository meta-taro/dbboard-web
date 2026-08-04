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
//
// Sorting (desktop ADR-0048) is display-only: the virtualizer walks display
// slots, and every slot resolves to a real row index through the
// permutation. Nothing here reorders `props.result.rows`.

import { computed, ref } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { useI18n } from "vue-i18n";
import type { QueryResult } from "../composables/useQueryExecution";
import { useResultSort } from "../composables/useResultSort";
import { formatValue } from "../utils/format-value";

const props = defineProps<{ result: QueryResult }>();

const { t } = useI18n();
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

const { keys, order, toggle, indicator } = useResultSort(() => props.result);

/** The real row index behind a display slot. */
function rowIndexFor(displayIndex: number): number {
  return order.value[displayIndex] ?? displayIndex;
}

function cellFor(rowIndex: number, columnIndex: number) {
  const row = props.result.rows[rowIndex];
  return formatValue(row ? (row[columnIndex] ?? null) : null);
}

function ariaSort(columnIndex: number): "ascending" | "descending" | "none" {
  const state = indicator(columnIndex);
  if (state === null) return "none";
  return state.ascending ? "ascending" : "descending";
}

function sortGlyph(columnIndex: number): string {
  const state = indicator(columnIndex);
  if (state === null) return "";
  const arrow = state.ascending ? "▲" : "▼";
  // A lone level needs no number; the arrow already says everything.
  return keys.value.length > 1 ? `${arrow}${state.level}` : arrow;
}

function onHeaderClick(columnIndex: number, event: MouseEvent) {
  // Ctrl on Windows/Linux, Shift everywhere (Cmd is reserved by the browser
  // on macOS for opening links, and metaKey on a <button> is harmless but
  // inconsistent across engines).
  toggle(columnIndex, event.ctrlKey || event.shiftKey);
}
</script>

<template>
  <div ref="scrollerRef" data-testid="result-grid" class="grid-scroll">
    <table class="grid">
      <thead>
        <tr>
          <th
            v-for="(column, columnIndex) in result.columns"
            :key="column.name"
            data-testid="result-grid__column-header"
            class="header-cell"
            scope="col"
            :aria-sort="ariaSort(columnIndex)"
          >
            <button
              type="button"
              data-testid="result-grid__sort-button"
              class="header-button"
              :title="t('result.sort.button', { column: column.name })"
              @click="onHeaderClick(columnIndex, $event)"
            >
              <span class="header-name">{{ column.name }}</span>
              <span
                v-if="indicator(columnIndex)"
                data-testid="result-grid__sort-indicator"
                class="header-indicator"
                aria-hidden="true"
                >{{ sortGlyph(columnIndex) }}</span
              >
              <!-- aria-sort carries the direction; only the level needs
                   spelling out, and only once there is more than one. -->
              <span v-if="indicator(columnIndex) && keys.length > 1" class="visually-hidden">{{
                t("result.sort.level", { level: indicator(columnIndex)?.level })
              }}</span>
            </button>
          </th>
        </tr>
      </thead>
      <tbody :style="{ height: `${totalHeight}px`, position: 'relative' }">
        <tr
          v-for="vRow in virtualRows"
          :key="vRow.index"
          data-testid="result-grid__row"
          :data-row-index="rowIndexFor(vRow.index)"
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
            :class="`cell--${cellFor(rowIndexFor(vRow.index), columnIndex).kind}`"
          >
            {{ cellFor(rowIndexFor(vRow.index), columnIndex).text }}
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
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-raised);
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
  padding: 0;
  text-align: left;
  background: var(--surface);
  border-bottom: 1px solid var(--border);
  font-weight: 600;
  white-space: nowrap;
}

.header-button {
  /* The whole header cell is the hit target — a small arrow would be a
     miss on touch, and the column name is the obvious thing to aim at. */
  display: flex;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  min-height: 36px;
  padding: 0.5rem 0.75rem;
  border: 0;
  background: none;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.header-button:hover {
  background: var(--surface-sunken);
}

.header-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}

.header-indicator {
  color: var(--text-muted);
  font-size: 0.75em;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

.row {
  display: flex;
}

.cell {
  flex: 1 1 0;
  min-width: 96px;
  padding: 0.4rem 0.75rem;
  border-bottom: 1px solid var(--border-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.cell--null {
  color: var(--text-muted);
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
  color: var(--text-muted);
  font-style: italic;
}
</style>
