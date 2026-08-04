<script setup lang="ts">
import { computed } from "vue";
import { useQueryHistory } from "../composables/useQueryHistory";

interface Props {
  connectionId: string;
  // Test-only escape hatch: lets the unit suite skip the useRuntimeConfig
  // branch (which requires a Nuxt instance). Production callers omit it
  // and resolve via `useRuntimeConfig()` inside the composable. Same
  // pattern as useConnections / useQueryExecution.
  apiBase?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: "replay", sql: string): void;
}>();

const { t } = useI18n();
const { history, state, lastError, refresh } = useQueryHistory(props.connectionId, {
  apiBase: props.apiBase,
});

// Render-only truncation so the rendered row stays compact; replay
// always emits the full record.sql so the editor receives the original.
const SQL_PREVIEW_MAX = 80;

function preview(sql: string): string {
  const single = sql.replace(/\s+/g, " ").trim();
  return single.length > SQL_PREVIEW_MAX ? single.slice(0, SQL_PREVIEW_MAX - 1) + "…" : single;
}

const count = computed(() => history.value.length);
const isLoading = computed(() => state.value === "loading");

function onReplay(sql: string) {
  emit("replay", sql);
}

// Expose refresh() so the parent sql-page can re-fetch the list after
// each Run completes (success or failure) — see issue 0015.
defineExpose({ refresh });
</script>

<template>
  <aside data-testid="history-sidebar" class="history-sidebar">
    <header class="header">
      <h3 class="title">{{ t("history.title", { count }) }}</h3>
      <button
        type="button"
        data-testid="history-refresh"
        class="refresh-button"
        :disabled="isLoading"
        @click="refresh()"
      >
        {{ t("history.refresh") }}
      </button>
    </header>

    <p v-if="lastError" data-testid="history-error" role="alert" class="error-banner">
      {{ t("history.error.load") }}: {{ lastError.message }}
    </p>

    <p v-if="count === 0" data-testid="history-empty" class="empty">
      {{ t("history.empty") }}
    </p>

    <ul v-else class="rows">
      <li
        v-for="record in history"
        :key="`${record.ts}|${record.sql}`"
        data-testid="history-row"
        class="row"
      >
        <div class="row-head">
          <span
            data-testid="history-status"
            class="badge"
            :class="record.status === 'ok' ? 'badge--ok' : 'badge--error'"
          >
            {{ t(record.status === "ok" ? "history.status.ok" : "history.status.error") }}
          </span>
          <time :datetime="record.ts" class="timestamp">{{ record.ts }}</time>
        </div>
        <code class="sql-preview">{{ preview(record.sql) }}</code>
        <div class="row-foot">
          <span class="duration">{{ t("history.duration", { ms: record.duration_ms }) }}</span>
          <button
            type="button"
            data-testid="history-replay"
            class="replay-button"
            @click="onReplay(record.sql)"
          >
            {{ t("history.replay") }}
          </button>
        </div>
      </li>
    </ul>
  </aside>
</template>

<style scoped>
.history-sidebar {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.title {
  margin: 0;
  font-size: 1rem;
}

.refresh-button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: transparent;
  font-size: 0.85rem;
  cursor: pointer;
}

.refresh-button:disabled {
  opacity: 0.6;
  cursor: progress;
}

.error-banner {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  background: var(--danger-tint);
  color: var(--danger-text);
  border: 1px solid var(--danger-tint-border);
  font-size: 0.85rem;
}

.empty {
  margin: 0;
  color: var(--text-muted);
  font-style: italic;
  font-size: 0.9rem;
}

.rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  padding: 0.5rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.row-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.75rem;
}

.timestamp {
  color: var(--text-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.badge {
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  font-size: 0.7rem;
  font-weight: 600;
  text-transform: uppercase;
}

.badge--ok {
  background: var(--success-tint);
  color: var(--success-text);
}

.badge--error {
  background: var(--danger-tint);
  color: var(--danger-text);
}

.sql-preview {
  display: block;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.8rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.row-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.duration {
  color: var(--text-muted);
  font-size: 0.75rem;
}

.replay-button {
  min-height: 44px;
  min-width: 44px;
  padding: 0 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  font-size: 0.85rem;
  cursor: pointer;
}

.replay-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
