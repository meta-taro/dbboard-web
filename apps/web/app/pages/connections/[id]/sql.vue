<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useRoute } from "vue-router";
import AiPanel from "../../../components/AiPanel.vue";
import DumpButton from "../../../components/DumpButton.vue";
import HistorySidebar from "../../../components/HistorySidebar.vue";
import ResultExportToolbar from "../../../components/ResultExportToolbar.vue";
import ErrorBanner from "../../../components/ErrorBanner.vue";
import RestorePanel from "../../../components/RestorePanel.vue";
import ResultGrid from "../../../components/ResultGrid.vue";
import SchemaBrowser from "../../../components/SchemaBrowser.vue";
import SidebarSplitter from "../../../components/SidebarSplitter.vue";
import { useConnections } from "../../../composables/useConnections";
import { useEditContext } from "../../../composables/useEditContext";
import { useQueryExecution } from "../../../composables/useQueryExecution";
import type { TableInfo } from "../../../composables/useSchemaBrowser";
import { useSidebarWidth } from "../../../composables/useSidebarWidth";
import { useTableDescriptions } from "../../../composables/useTableDescriptions";
import { fromCategorised } from "../../../utils/display-error";

const { t } = useI18n();
const route = useRoute();
const connectionId = String(route.params.id);

const { result, sourceTable, state, lastError, run } = useQueryExecution(connectionId);

// Which dialect the sidebar quotes identifiers in comes from the connection's
// driver (ADR-0072), and there is no `GET /connections/:id` to ask — so the
// page reads it out of the list. `undefined` until that fetch lands, which
// the browser resolves to ANSI rather than guessing.
const { list: connections } = useConnections();
const driver = computed(() => connections.value.find((c) => c.id === connectionId)?.driver);

// Whether the grid is editable, and against what (ticket 0028). Read back
// from `sourceTable` after every run rather than set from the browse payload:
// a failed run leaves the previous rows on screen, and those rows are still
// the previous table's. Reusing the payload would hand a new table's key to
// an old table's rows.
const {
  context: editContext,
  noPk: noEditKey,
  load: loadEditContext,
} = useEditContext(connectionId);

function syncEditContext() {
  // Fire-and-forget: the key is cleared synchronously inside, so the grid is
  // read-only for the whole window before the answer arrives.
  void loadEditContext(sourceTable.value);
}

// The divider reports where the user is asking it to go; what is legal is the
// composable's call. The page only has to publish the answer as a custom
// property, so the sidebar column can be sized from CSS (desktop ADR-0083).
const {
  width: sidebarWidth,
  setWidth: setSidebarWidth,
  nudge: nudgeSidebar,
  reset: resetSidebar,
} = useSidebarWidth();

// The sidebar fetched the tables; the AI panel needs them (ticket 0032
// slice A). The page is the only place that can join the two, and it
// forwards nothing until the fetch has actually come back: the sidebar's
// list is `[]` while loading and `[]` after a failure too, and forwarding
// that would tell the model this connection has no tables when the truth
// is that we never found out. An empty list *after* a successful fetch is
// a real answer and is forwarded as one.
const schemaRef = ref<InstanceType<typeof SchemaBrowser> | null>(null);
const aiTables = computed<ReadonlyArray<TableInfo> | undefined>(() =>
  schemaRef.value?.state === "idle" ? schemaRef.value.tables : undefined,
);

// Column detail for the AI panel (ticket 0032 slice E). The panel is
// connection-agnostic by design, so the page hands it the two things that
// are not: whether this connection can describe tables at all, and the
// fan-out that does it. Passing the id instead would put a second fetcher
// inside a component whose whole contract is that it owns no connection.
const { supported: canDescribe, describeAll } = useTableDescriptions(connectionId);

const sqlInput = ref("");
/** The statement behind the rows on screen, kept so a save can show what it
 *  wrote. Only a browse sets it — nothing else produces an editable grid. */
const browseSql = ref("");
const isLoading = computed(() => state.value === "loading");
const historyRef = ref<InstanceType<typeof HistorySidebar> | null>(null);
const sqlInputRef = ref<HTMLTextAreaElement | null>(null);

const summaryParams = computed(() =>
  result.value
    ? {
        columns: result.value.columns.length,
        rows: result.value.rows.length,
        affected: result.value.rows_affected,
      }
    : null,
);

const hasRows = computed(() => (result.value?.rows.length ?? 0) > 0);

async function onRun() {
  await run(sqlInput.value);
  syncEditContext();
  // Pick up the just-emitted history record. Sidebar refresh is fire-
  // and-forget here — the editor surface stays responsive even if the
  // history fetch lags. Failures are also persisted (interceptor logs
  // status="error"), so refresh fires unconditionally.
  await historyRef.value?.refresh();
}

async function onBrowse(payload: { sql: string; table: TableInfo }) {
  // The statement lands in the editor before it runs. Nothing executes here
  // that the user cannot see and re-run, and the source table travels with
  // the run rather than being inferred from the text afterwards — that
  // provenance is what decides whether the grid is editable (ticket 0028).
  sqlInput.value = payload.sql;
  browseSql.value = payload.sql;
  await run(payload.sql, payload.table);
  syncEditContext();
  await historyRef.value?.refresh();
}

/**
 * Refresh the grid after a save wrote through it.
 *
 * Re-runs the statement that produced the rows, not the editor's current
 * text: the editor is a scratchpad, and replacing the rows someone just
 * edited with an unrelated draft query is a strange thing for Save to do.
 * Desktop's `reloadAfterSave` re-runs the editor instead — this is the one
 * place the mirror is deliberately narrower.
 */
async function onSaved() {
  const table = sourceTable.value;
  if (table === null) return;
  await run(browseSql.value, table);
  syncEditContext();
  await historyRef.value?.refresh();
}

function onReplay(sql: string) {
  // Load the past SQL into the editor; the user still presses Run.
  // Auto-execute would be surprising and could re-run an expensive query.
  sqlInput.value = sql;
}

async function onInsertIdentifier(text: string) {
  const el = sqlInputRef.value;
  if (!el) {
    sqlInput.value += text;
    return;
  }
  const start = el.selectionStart ?? sqlInput.value.length;
  const end = el.selectionEnd ?? sqlInput.value.length;
  const next = sqlInput.value.slice(0, start) + text + sqlInput.value.slice(end);
  sqlInput.value = next;
  const caret = start + text.length;
  // Wait for v-model to flush so the textarea node has the new value before
  // we adjust the caret — otherwise selectionStart resets to the end.
  await nextTick();
  el.focus();
  el.setSelectionRange(caret, caret);
}

function onEditorKeydown(event: KeyboardEvent) {
  // IME composition guard: Safari and older Android WebViews emit a
  // synthetic keyCode 229 on the keydown that commits an IME candidate
  // without setting isComposing yet — check both.
  if (event.isComposing || event.keyCode === 229) {
    return;
  }
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    void onRun();
  }
}
</script>

<template>
  <section class="sql-page">
    <header class="header">
      <div class="header-text">
        <h2>{{ t("sql.title") }}</h2>
        <p class="connection-id">
          <code>{{ connectionId }}</code>
        </p>
      </div>
      <!-- A dump is of the connection, not of the grid, so it belongs to the
           page header rather than the result toolbar. Restore is its inverse
           and sits beside it for the same reason. -->
      <DumpButton :connection-id="connectionId" />
      <RestorePanel :connection-id="connectionId" />
    </header>

    <ErrorBanner
      v-if="lastError"
      data-testid="error-banner"
      :error="fromCategorised(lastError, t)"
    />

    <div class="columns" :style="{ '--sidebar-width': `${sidebarWidth}px` }">
      <div class="editor-column">
        <label class="editor-label" for="sql-input">{{ t("sql.editor.label") }}</label>
        <textarea
          id="sql-input"
          ref="sqlInputRef"
          v-model="sqlInput"
          data-testid="sql-input"
          class="editor"
          rows="6"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
          @keydown="onEditorKeydown"
        />

        <div class="actions">
          <button
            type="button"
            data-testid="run-button"
            class="run-button"
            :disabled="isLoading"
            @click="onRun"
          >
            {{ isLoading ? t("sql.running") : t("sql.run") }}
          </button>
        </div>

        <section class="result-area">
          <p v-if="!result" data-testid="result-empty" class="result-empty">
            {{ t("sql.result.empty") }}
          </p>
          <template v-else>
            <p data-testid="result-summary" class="result-summary">
              {{ t("sql.result.summary", summaryParams ?? {}) }}
            </p>
            <!-- Both tied to hasRows: a statement that returns no rows has
                 nothing to export but a header line. -->
            <template v-if="hasRows">
              <ResultExportToolbar :result="result" />
              <!-- Only shown when a describe actually came back without a
                   key. A describe that failed leaves the grid read-only too,
                   but silently: it told us nothing to report. -->
              <p v-if="noEditKey" data-testid="readonly-no-pk" class="readonly-note" role="note">
                {{ t("result.edit.readonly-no-pk") }}
              </p>
              <ResultGrid :result="result" :edit="editContext" @saved="onSaved" />
            </template>
          </template>
        </section>

        <AiPanel
          :current-sql="sqlInput"
          :tables="aiTables"
          :can-describe="canDescribe"
          :describe-tables="describeAll"
          @insert="onInsertIdentifier"
        />
      </div>

      <SidebarSplitter
        :width="sidebarWidth"
        @resize="setSidebarWidth"
        @nudge="nudgeSidebar"
        @reset="resetSidebar"
      />

      <div class="sidebar-column">
        <SchemaBrowser
          ref="schemaRef"
          :connection-id="connectionId"
          :driver="driver"
          @insert="onInsertIdentifier"
          @browse="onBrowse"
        />
        <HistorySidebar ref="historyRef" :connection-id="connectionId" @replay="onReplay" />
      </div>
    </div>
  </section>
</template>

<style scoped>
.sql-page {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.header {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}

.header-text {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.header h2 {
  margin: 0;
}

.connection-id {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.columns {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.editor-column {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  min-width: 0;
}

.sidebar-column {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

/* Below the breakpoint the two panes stack, and a vertical divider between
   them would resize nothing. */
.columns > .splitter {
  display: none;
}

@media (min-width: 768px) {
  .columns {
    flex-direction: row;
    align-items: flex-start;
  }
  .editor-column {
    flex: 1 1 auto;
  }
  .sidebar-column {
    /* Set on `.columns` by the page from `useSidebarWidth`, which starts at
       the 280px this rule used to hard-code. */
    flex: 0 0 var(--sidebar-width);
  }
  .columns > .splitter {
    display: block;
  }
}

.editor-label {
  font-size: 0.9rem;
  font-weight: 600;
}

.editor {
  width: 100%;
  box-sizing: border-box;
  /* Touch target >= 44 px per Phase 1.5 DoD — `rows="6"` already
     exceeds that, but font-size: 1rem keeps mobile zoom from kicking
     in on iOS Safari. */
  min-height: 44px;
  padding: 0.75rem;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 1rem;
  line-height: 1.4;
  border: 1px solid var(--border);
  border-radius: 4px;
  resize: vertical;
}

.editor:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.actions {
  display: flex;
  gap: 0.5rem;
}

.run-button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 1.25rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 0.95rem;
  cursor: pointer;
}

.run-button:disabled {
  opacity: 0.6;
  cursor: progress;
}

.run-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.result-area {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.result-empty {
  margin: 0;
  color: var(--text-muted);
  font-style: italic;
}

.result-summary {
  margin: 0;
}

/* An explanation, not a failure: the query worked, the rows are fine, and
   only writing them back is unavailable. Muted rather than tinted. */
.readonly-note {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
}
</style>
