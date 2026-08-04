<script setup lang="ts">
import { computed, nextTick, ref } from "vue";
import { useRoute } from "vue-router";
import AiPanel from "../../../components/AiPanel.vue";
import HistorySidebar from "../../../components/HistorySidebar.vue";
import ResultExportToolbar from "../../../components/ResultExportToolbar.vue";
import ErrorBanner from "../../../components/ErrorBanner.vue";
import ResultGrid from "../../../components/ResultGrid.vue";
import SchemaBrowser from "../../../components/SchemaBrowser.vue";
import SidebarSplitter from "../../../components/SidebarSplitter.vue";
import { useQueryExecution } from "../../../composables/useQueryExecution";
import { useSidebarWidth } from "../../../composables/useSidebarWidth";
import { fromCategorised } from "../../../utils/display-error";

const { t } = useI18n();
const route = useRoute();
const connectionId = String(route.params.id);

const { result, state, lastError, run } = useQueryExecution(connectionId);

// The divider reports where the user is asking it to go; what is legal is the
// composable's call. The page only has to publish the answer as a custom
// property, so the sidebar column can be sized from CSS (desktop ADR-0083).
const {
  width: sidebarWidth,
  setWidth: setSidebarWidth,
  nudge: nudgeSidebar,
  reset: resetSidebar,
} = useSidebarWidth();

const sqlInput = ref("");
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
  // Pick up the just-emitted history record. Sidebar refresh is fire-
  // and-forget here — the editor surface stays responsive even if the
  // history fetch lags. Failures are also persisted (interceptor logs
  // status="error"), so refresh fires unconditionally.
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
      <h2>{{ t("sql.title") }}</h2>
      <p class="connection-id">
        <code>{{ connectionId }}</code>
      </p>
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
              <ResultGrid :result="result" />
            </template>
          </template>
        </section>

        <AiPanel :current-sql="sqlInput" @insert="onInsertIdentifier" />
      </div>

      <SidebarSplitter
        :width="sidebarWidth"
        @resize="setSidebarWidth"
        @nudge="nudgeSidebar"
        @reset="resetSidebar"
      />

      <div class="sidebar-column">
        <SchemaBrowser :connection-id="connectionId" @insert="onInsertIdentifier" />
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
</style>
