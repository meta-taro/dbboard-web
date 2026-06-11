<script setup lang="ts">
import { computed, ref } from "vue";
import { useRoute } from "vue-router";
import { useQueryExecution } from "../../../composables/useQueryExecution";

const { t } = useI18n();
const route = useRoute();
const connectionId = String(route.params.id);

const { result, state, lastError, run } = useQueryExecution(connectionId);

const sqlInput = ref("");
const isLoading = computed(() => state.value === "loading");

const summaryParams = computed(() =>
  result.value
    ? {
        columns: result.value.columns.length,
        rows: result.value.rows.length,
        affected: result.value.rows_affected,
      }
    : null,
);

const firstRowJson = computed(() =>
  result.value && result.value.rows.length > 0 ? JSON.stringify(result.value.rows[0]) : null,
);

async function onRun() {
  await run(sqlInput.value);
}

function onEditorKeydown(event: KeyboardEvent) {
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

    <p v-if="lastError" data-testid="error-banner" role="alert" class="error-banner">
      {{ t(lastError.i18nKey) }}: {{ lastError.message }}
    </p>

    <label class="editor-label" for="sql-input">{{ t("sql.editor.label") }}</label>
    <textarea
      id="sql-input"
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
        <template v-if="firstRowJson">
          <h3 class="preview-heading">{{ t("sql.result.preview-heading") }}</h3>
          <pre data-testid="result-preview" class="result-preview">{{ firstRowJson }}</pre>
        </template>
      </template>
    </section>
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

.error-banner {
  padding: 0.75rem 1rem;
  border-radius: 4px;
  background: rgba(220, 38, 38, 0.1);
  color: #991b1b;
  border: 1px solid rgba(220, 38, 38, 0.3);
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
  color: #ffffff;
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

.preview-heading {
  margin: 0;
  font-size: 0.95rem;
}

.result-preview {
  margin: 0;
  padding: 0.5rem;
  background: rgba(0, 0, 0, 0.03);
  border-radius: 4px;
  overflow-x: auto;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85rem;
}
</style>
