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
//
// Double-clicking a cell whose value the column could not show in full opens
// it in a viewer (desktop ADR-0082 decision 5). The decision of what counts
// as "in full" lives in app/utils/display-width.ts.
//
// With an `edit` prop the same double-click opens an editor instead (ticket
// 0028, desktop ADR-0042 as shipped in ADR-0063). Editing is staged, never
// live: every changed cell sits tinted in the grid until Save writes them as
// one UPDATE per touched row, and a failed Save leaves them exactly where
// they were. Which cells may be edited is decided by the prop — a result the
// page could not attribute to a single table arrives with `edit` absent, and
// this component gains no affordance at all.

import { computed, nextTick, ref, watch } from "vue";
import { useVirtualizer } from "@tanstack/vue-virtual";
import { useI18n } from "vue-i18n";
import type { QueryResult, Value } from "../composables/useQueryExecution";
import { useResultSort } from "../composables/useResultSort";
import { useRowUpdate } from "../composables/useRowUpdate";
import { fromCategorised, plainError, type DisplayError } from "../utils/display-error";
import { needsWideEditor } from "../utils/display-width";
import { formatValue } from "../utils/format-value";
import { buildRowUpdates, cellKey, type EditContext, type StagedValue } from "../utils/grid-edit";
import CellEditorDialog from "./CellEditorDialog.vue";
import CellViewer from "./CellViewer.vue";
import ErrorBanner from "./ErrorBanner.vue";

const props = defineProps<{
  result: QueryResult;
  /** Present when the result is an editable table browse — which connection
   *  and table the rows came from, and the key each UPDATE is written on.
   *  Absent or null means read-only. */
  edit?: EditContext | null;
  /** Overrides the runtime config's API base, for tests and for embedding. */
  apiBase?: string;
}>();

/** A save landed; the rows on screen are now stale. The page re-runs the
 *  browse — this component does not know the query that produced it. */
const emit = defineEmits<{ saved: [] }>();

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

/** Each visible slot paired with the row it resolves to, so the template says
 *  `slot.index` once instead of resolving the permutation per cell. */
const displayRows = computed(() =>
  virtualRows.value.map((item) => ({ item, index: rowIndexFor(item.index) })),
);

function cellFor(rowIndex: number, columnIndex: number) {
  // A staged edit is what the cell now says. It is rendered as a string even
  // when it replaces a number, because that is what will be written — the
  // right-aligned numeric styling would claim the engine had accepted it.
  const pending = stagedAt(rowIndex, columnIndex);
  if (pending === null) return { kind: "null" as const, text: "NULL" };
  if (pending !== undefined) return { kind: "string" as const, text: pending };
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

const viewer = ref<{ column: string; value: string } | null>(null);

function openViewer(rowIndex: number, columnIndex: number) {
  const cell = props.result.rows[rowIndex]?.[columnIndex] ?? null;
  // NULL and blobs reach the screen as placeholders — "NULL", "<blob: N
  // chars>" — rather than as their value, so a viewer would show exactly
  // what the cell already shows. Mirrors desktop's `openCell`.
  //
  // The width test below happens to reject both today, because those two
  // placeholders are short. That is a fact about format-value, not about
  // what may be opened, and it would stop being true the day a blob renders
  // its bytes. The rule is stated here, on the value.
  if (cell === null || typeof cell === "object") return;
  const text = formatValue(cell).text;
  if (!needsWideEditor(text)) return;
  viewer.value = { column: props.result.columns[columnIndex]?.name ?? "", value: text };
}

function onHeaderClick(columnIndex: number, event: MouseEvent) {
  // Ctrl on Windows/Linux, Shift everywhere (Cmd is reserved by the browser
  // on macOS for opening links, and metaKey on a <button> is harmless but
  // inconsistent across engines).
  toggle(columnIndex, event.ctrlKey || event.shiftKey);
}

/* ── Editing ─────────────────────────────────────────────────────────────
   Staged edits keyed on the ORIGINAL row index, so a re-sort moves the tint
   with its row rather than with its position. See app/utils/grid-edit.ts. */

const rowUpdate = useRowUpdate({ apiBase: props.apiBase });
const saving = rowUpdate.saving;
const staged = ref(new Map<string, StagedValue>());
/** The cell the inline input is open on. Its text is `draft`, kept separate
 *  so the template can `v-model` it without asserting non-null. */
const editing = ref<{ row: number; col: number } | null>(null);
const draft = ref("");
/** The cell the full editor dialog is open on, and the text it opened with.
 *  Never set at the same time as `editing`. */
const expanded = ref<{ row: number; col: number; draft: string } | null>(null);
const buildError = ref("");
const status = ref("");

// A new result is new rows. An edit staged against row 0 of the old one is,
// against the new one, an edit to whichever row happens to be first — so it
// goes, along with anything the last save had to say about it.
watch(
  () => props.result,
  () => {
    staged.value = new Map();
    editing.value = null;
    expanded.value = null;
    buildError.value = "";
    status.value = "";
    rowUpdate.reset();
  },
);

// Focus follows the editor, or opening one would be two gestures. Deferred a
// tick because the input does not exist until the cell re-renders, and found
// by query rather than by template ref: the input sits inside two `v-for`s, so
// a ref would arrive as an array. Exactly one editor is ever open.
watch(editing, async (open) => {
  if (!open) return;
  await nextTick();
  const el = scrollerRef.value?.querySelector<HTMLInputElement>(".editor-input");
  el?.focus();
  el?.select();
});

function stagedAt(rowIndex: number, columnIndex: number): StagedValue | undefined {
  return staged.value.get(cellKey(rowIndex, columnIndex));
}

function isDirty(rowIndex: number, columnIndex: number): boolean {
  return staged.value.has(cellKey(rowIndex, columnIndex));
}

function rawCell(rowIndex: number, columnIndex: number): Value {
  return props.result.rows[rowIndex]?.[columnIndex] ?? null;
}

/** Blobs are placeholders on screen — the grid never had the bytes, so it
 *  cannot offer to change them. */
function isBlob(value: Value): boolean {
  return typeof value === "object" && value !== null;
}

/** Primary-key columns are held fixed: they are what the UPDATE is keyed on,
 *  and editing one would rewrite the identity of the row being addressed. */
function columnEditable(columnIndex: number): boolean {
  const column = props.result.columns[columnIndex];
  return !!props.edit && !!column && !props.edit.pk.includes(column.name);
}

function cellEditable(rowIndex: number, columnIndex: number): boolean {
  return columnEditable(columnIndex) && !isBlob(rawCell(rowIndex, columnIndex));
}

function isEditing(rowIndex: number, columnIndex: number): boolean {
  return editing.value?.row === rowIndex && editing.value?.col === columnIndex;
}

/** The text an editor opens on. A NULL starts as empty, not as the word
 *  "NULL": the draft is what will be written, and pre-filling it with the
 *  placeholder would make the obvious edit — type over it — write four
 *  letters into the column. */
function draftFor(rowIndex: number, columnIndex: number): string {
  const pending = stagedAt(rowIndex, columnIndex);
  const current = pending !== undefined ? pending : rawCell(rowIndex, columnIndex);
  return current === null ? "" : formatValue(current).text;
}

function onCellDblClick(rowIndex: number, columnIndex: number) {
  if (!cellEditable(rowIndex, columnIndex)) {
    openViewer(rowIndex, columnIndex);
    return;
  }
  const text = draftFor(rowIndex, columnIndex);
  // A value the inline box cannot hold goes straight to the dialog. Opening a
  // 40-character slot onto 500 characters of prose is not an editor — and a
  // single-line <input> would strip the newlines out of a multi-line value on
  // its way in, which is worse than useless.
  if (needsWideEditor(text)) {
    expanded.value = { row: rowIndex, col: columnIndex, draft: text };
    editing.value = null;
    return;
  }
  draft.value = text;
  editing.value = { row: rowIndex, col: columnIndex };
}

function setStaged(rowIndex: number, columnIndex: number, value: StagedValue) {
  // Replaced rather than mutated: a Map is reactive by identity here, and the
  // dirty tint is read once per visible cell on every render.
  const next = new Map(staged.value);
  next.set(cellKey(rowIndex, columnIndex), value);
  staged.value = next;
}

/** Commit the open inline editor's text as the cell's new value. */
function commitEditor() {
  const open = editing.value;
  if (!open) return;
  editing.value = null;
  setStaged(open.row, open.col, draft.value);
}

function nullEditor() {
  const open = editing.value;
  if (!open) return;
  editing.value = null;
  setStaged(open.row, open.col, null);
}

/** Un-stage the cell, putting back what the engine returned. A web addition:
 *  Discard is all-or-nothing, and a user who mistyped one cell of six should
 *  not have to retype the other five. */
function revertEditor() {
  const open = editing.value;
  if (!open) return;
  editing.value = null;
  const next = new Map(staged.value);
  next.delete(cellKey(open.row, open.col));
  staged.value = next;
}

/** Hand the inline draft to the dialog, so a value that turned out to need
 *  more room is not retyped. */
function expandEditor() {
  const open = editing.value;
  if (!open) return;
  editing.value = null;
  expanded.value = { row: open.row, col: open.col, draft: draft.value };
}

function onEditorKeydown(event: KeyboardEvent) {
  if (event.key === "Enter") {
    event.preventDefault();
    commitEditor();
  } else if (event.key === "Escape") {
    event.preventDefault();
    editing.value = null;
  }
}

function applyExpanded(text: string) {
  const open = expanded.value;
  if (!open) return;
  expanded.value = null;
  setStaged(open.row, open.col, text);
}

function nullExpanded() {
  const open = expanded.value;
  if (!open) return;
  expanded.value = null;
  setStaged(open.row, open.col, null);
}

function discardEdits() {
  staged.value = new Map();
  editing.value = null;
  expanded.value = null;
  buildError.value = "";
  rowUpdate.reset();
}

const editError = computed<DisplayError | null>(() => {
  // The grid's own refusal has no lower layer to have come from, so both
  // halves are the same sentence; a failed write does, and keeps its
  // untranslated body under a translated prefix.
  if (buildError.value) return plainError(buildError.value);
  const wire = rowUpdate.lastError.value;
  return wire ? fromCategorised(wire, t) : null;
});

// An open editor counts: Save has to be reachable straight from the input, or
// typing a value and clicking the button that writes it would be two gestures
// with a dead one in between.
const showEditBar = computed(
  () =>
    !!props.edit && (staged.value.size > 0 || editing.value !== null || editError.value !== null),
);

const canSave = computed(() => !saving.value && (staged.value.size > 0 || editing.value !== null));

/**
 * Write every staged cell as one UPDATE per touched row.
 *
 * Stops at the first failure with the remaining edits still staged, so a
 * half-written save is visible as exactly the rows that did not land.
 */
async function saveEdits() {
  const context = props.edit;
  if (!context || saving.value) return;
  // An editor left open is an edit the user made; flushing it first is why
  // clicking Save straight from the input does not lose the last cell.
  commitEditor();
  if (staged.value.size === 0) return;

  let updates;
  try {
    updates = buildRowUpdates(staged.value, props.result.rows, props.result.columns, context.pk);
  } catch (e: unknown) {
    // Refused before anything is sent: an unkeyed table, or a key column the
    // browse did not select. Both name their own fix.
    buildError.value = e instanceof Error ? e.message : String(e);
    return;
  }
  buildError.value = "";

  if (!(await rowUpdate.applyUpdates(context.connectionId, context.table, updates))) return;
  staged.value = new Map();
  status.value = t("result.edit.saved", { count: updates.length });
  emit("saved");
}
</script>

<template>
  <div class="wrap">
    <!-- Above the scroller, not inside it: what is unsaved must not be able to
         scroll out of sight. -->
    <div v-if="showEditBar" data-testid="result-grid__edit-bar" class="edit-bar">
      <div class="edit-line">
        <span class="edit-label">{{ t("result.edit.bar-label") }}</span>
        <span v-if="staged.size > 0" data-testid="result-grid__edit-count" class="edit-count">{{
          t("result.edit.pending", { count: staged.size })
        }}</span>
        <span class="edit-spacer" />
        <button
          type="button"
          data-testid="result-grid__discard"
          class="ghost"
          @click="discardEdits"
        >
          {{ t("result.edit.discard") }}
        </button>
        <!-- mousedown fires before the input's blur, so the open editor is
             flushed into staging before the click handler reads it. -->
        <button
          type="button"
          data-testid="result-grid__save"
          class="primary"
          :disabled="!canSave"
          @mousedown.prevent="commitEditor"
          @click="saveEdits"
        >
          {{ saving ? t("result.edit.saving") : t("result.edit.save") }}
        </button>
      </div>
      <ErrorBanner
        v-if="editError"
        data-testid="result-grid__edit-error"
        :error="editError"
        dense
      />
    </div>
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
            v-for="slot in displayRows"
            :key="slot.item.index"
            data-testid="result-grid__row"
            :data-row-index="slot.index"
            class="row"
            :style="{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${slot.item.start}px)`,
              height: `${slot.item.size}px`,
            }"
          >
            <td
              v-for="(column, columnIndex) in result.columns"
              :key="column.name"
              data-testid="result-grid__cell"
              class="cell"
              :class="[
                `cell--${cellFor(slot.index, columnIndex).kind}`,
                {
                  'cell--dirty': isDirty(slot.index, columnIndex),
                  'cell--editable': cellEditable(slot.index, columnIndex),
                  'cell--editing': isEditing(slot.index, columnIndex),
                },
              ]"
              :title="cellEditable(slot.index, columnIndex) ? t('result.edit.hint') : undefined"
              @dblclick="onCellDblClick(slot.index, columnIndex)"
            >
              <!-- The value stays in the DOM while the editor is open, hidden
                   rather than removed, so the column keeps the width it had. -->
              <span :class="{ 'cell-value--hidden': isEditing(slot.index, columnIndex) }">{{
                cellFor(slot.index, columnIndex).text
              }}</span>
              <span v-if="isEditing(slot.index, columnIndex)" class="editor">
                <input
                  v-model="draft"
                  class="editor-input"
                  data-testid="result-grid__cell-input"
                  type="text"
                  spellcheck="false"
                  :aria-label="t('result.edit.editing')"
                  @keydown="onEditorKeydown"
                  @blur="commitEditor"
                />
                <!-- All three fire on mousedown with the default prevented:
                     mousedown lands before the input's blur, so the draft has
                     to move before the blur commits it. -->
                <button
                  type="button"
                  data-testid="result-grid__cell-expand"
                  class="editor-button"
                  :title="t('result.edit.expand')"
                  @mousedown.prevent.stop="expandEditor"
                >
                  ⤢
                </button>
                <button
                  type="button"
                  data-testid="result-grid__cell-null"
                  class="editor-button"
                  :title="t('result.edit.null-title')"
                  @mousedown.prevent.stop="nullEditor"
                >
                  ∅
                </button>
                <button
                  v-if="isDirty(slot.index, columnIndex)"
                  type="button"
                  data-testid="result-grid__cell-revert"
                  class="editor-button"
                  :title="t('result.edit.revert')"
                  @mousedown.prevent.stop="revertEditor"
                >
                  ↩
                </button>
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <p data-testid="result-grid__status" class="visually-hidden" role="status" aria-live="polite">
      {{ status }}
    </p>
    <CellViewer
      v-if="viewer"
      :column="viewer.column"
      :value="viewer.value"
      @close="viewer = null"
    />
    <CellEditorDialog
      v-if="expanded"
      :column="result.columns[expanded.col]?.name ?? ''"
      :value="expanded.draft"
      @apply="applyExpanded"
      @set-null="nullExpanded"
      @cancel="expanded = null"
    />
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.edit-bar {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--warn-tint-border);
  border-radius: 4px;
  background: var(--warn-tint);
}

.edit-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.edit-label {
  font-weight: 600;
}

.edit-count {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.edit-spacer {
  flex: 1 1 auto;
}

.ghost,
.primary {
  height: 30px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.primary {
  border-color: var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
}

.ghost:hover {
  background: var(--surface-sunken);
}

.primary:disabled {
  opacity: 0.6;
  cursor: default;
}

.ghost:focus-visible,
.primary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

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

.cell--editable {
  cursor: cell;
}

/* Tinted, not just bordered: at a glance across a wide grid the question is
   "which of these have I changed", and a colour answers it from further away
   than an outline does. */
.cell--dirty {
  background: var(--warn-tint);
  font-style: normal;
}

.cell--editing {
  /* The editor is absolutely positioned over the cell, and needs to be able
     to grow past its right edge. */
  position: relative;
  overflow: visible;
}

.cell-value--hidden {
  visibility: hidden;
}

.editor {
  position: absolute;
  inset: 0 auto 0 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 2px;
  min-width: 100%;
  padding: 0 2px;
  background: var(--surface-raised);
}

.editor-input {
  flex: 1 1 auto;
  min-width: 0;
  height: 26px;
  padding: 0 4px;
  border: 1px solid var(--accent);
  border-radius: 3px;
  background: var(--surface);
  color: inherit;
  font: inherit;
}

.editor-input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -1px;
}

.editor-button {
  flex: none;
  width: 24px;
  height: 26px;
  border: 1px solid var(--border);
  border-radius: 3px;
  background: var(--surface);
  color: inherit;
  font-size: 0.8rem;
  line-height: 1;
  cursor: pointer;
}

.editor-button:hover {
  background: var(--surface-sunken);
}
</style>
