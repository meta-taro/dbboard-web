<script setup lang="ts">
// Logical restore / import (ticket 0030, the web mirror of desktop ADR-0051
// and of RestoreDialog.svelte there).
//
// Desktop puts this in a modal because it opens a native file dialog and can
// subscribe to a progress event. Here it is inline on the page for the same
// reason the dump confirmation is: the browser's own file picker is the
// dialog, and the one thing that would justify a modal — holding attention on
// a progress bar — does not exist, because HTTP gives no channel to report
// per-statement progress over. So a run is indeterminate, and the panel says
// so rather than faking a bar.
//
// It sits in the page header next to the dump for the same reason: a restore
// is of the connection, not of whatever the grid happens to be showing.

import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useRestore } from "../composables/useRestore";
import { fromCategorised } from "../utils/display-error";

const props = defineProps<{ connectionId: string; apiBase?: string }>();

const { t } = useI18n();
const {
  state,
  plan,
  outcome,
  lastError,
  filename,
  confirmed,
  onError,
  mustConfirm,
  canRun,
  preflight,
  run,
  cancel,
} = useRestore(props.connectionId, { apiBase: props.apiBase });

const isRunning = computed(() => state.value === "running");
const isReady = computed(() => state.value === "ready");
const hasUnparsed = computed(() => (plan.value?.unparsed_count ?? 0) > 0);
const error = computed(() =>
  lastError.value ? fromCategorised(lastError.value, t).localized : null,
);

// `File` is not narrowed off the event: jsdom cannot construct a real one for
// the tests, and the only thing wanted from it is a name and its text.
interface ChosenFile {
  name: string;
  text: () => Promise<string>;
}

async function onFileChange(event: Event): Promise<void> {
  const file = (event.target as { files?: ArrayLike<ChosenFile> | null }).files?.[0];
  if (!file) return;
  await preflight(await file.text(), file.name);
}
</script>

<template>
  <div class="restore" role="group" :aria-label="t('restore.label')">
    <label class="restore__choose">
      <span class="restore__choose-text">{{ t("restore.choose") }}</span>
      <input
        type="file"
        accept=".sql,application/sql,text/plain"
        data-testid="restore__file"
        :disabled="isRunning"
        @change="onFileChange"
      />
    </label>

    <p v-if="filename" class="restore__filename" data-testid="restore__filename">
      <code>{{ filename }}</code>
    </p>

    <template v-if="isReady && plan">
      <p class="restore__summary" data-testid="restore__summary">
        {{
          t("restore.summary", {
            statements: plan.statements_total,
            ddl: plan.ddl_count,
            data: plan.data_count,
          })
        }}
      </p>

      <p v-if="hasUnparsed" class="restore__warn" data-testid="restore__unparsed-warn" role="alert">
        {{ t("restore.unparsedWarn", { count: plan.unparsed_count }) }}
      </p>

      <!-- The one safety gate (ADR-0051): writing into a database that
           already holds tables. An empty target restores without a prompt. -->
      <template v-if="mustConfirm">
        <p class="restore__warn" data-testid="restore__nonempty-warn" role="alert">
          {{ t("restore.nonemptyWarn", { tables: plan.existing_tables.length }) }}
        </p>
        <label class="restore__confirm-label">
          <input v-model="confirmed" type="checkbox" data-testid="restore__confirm" />
          {{ t("restore.confirmLabel") }}
        </label>
      </template>

      <label class="restore__onerror-label">
        <span>{{ t("restore.onError.label") }}</span>
        <select v-model="onError" data-testid="restore__onerror">
          <option value="stop">{{ t("restore.onError.stop") }}</option>
          <option value="continue">{{ t("restore.onError.continue") }}</option>
        </select>
      </label>

      <button
        type="button"
        class="restore__button"
        data-testid="restore__run"
        :disabled="!canRun"
        @click="run()"
      >
        {{ t("restore.run") }}
      </button>
    </template>

    <button
      v-if="isRunning"
      type="button"
      class="restore__button"
      data-testid="restore__cancel"
      @click="cancel()"
    >
      {{ t("restore.cancel") }}
    </button>

    <p v-if="state === 'cancelled'" class="restore__outcome" data-testid="restore__outcome">
      {{ t("restore.cancelled") }}
    </p>
    <template v-else-if="state === 'done' && outcome">
      <p class="restore__outcome" data-testid="restore__outcome">
        {{
          t(outcome.atomic ? "restore.doneAtomic" : "restore.done", {
            statements: outcome.statements_run,
          })
        }}
      </p>
      <p v-if="outcome.failures.length > 0" class="restore__warn" data-testid="restore__failures">
        {{ t("restore.failures", { count: outcome.failures.length }) }}
      </p>
    </template>

    <p v-if="error" class="restore__error" data-testid="restore__error">{{ error }}</p>

    <p class="restore__note">{{ t("restore.note") }}</p>

    <!-- Rendered from the start, empty: a live region inserted at the same
         moment it gains text is not reliably announced. -->
    <span class="restore__status" data-testid="restore__status" role="status" aria-live="polite">{{
      isRunning ? t("restore.running") : ""
    }}</span>
  </div>
</template>

<style scoped>
.restore {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.restore__choose {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.85rem;
  color: var(--text-muted);
}

.restore__button {
  /* Touch target ≥ 44 × 44 per Phase 1.5 DoD. */
  min-height: 44px;
  padding: 0 0.75rem;
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--surface-raised);
  color: var(--text);
  font-size: 0.9rem;
  cursor: pointer;
}

.restore__button:hover:not(:disabled) {
  background: var(--surface-sunken);
}

.restore__button:disabled {
  cursor: default;
  opacity: 0.6;
}

.restore__confirm-label,
.restore__onerror-label {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.85rem;
  color: var(--text);
}

.restore__filename,
.restore__summary,
.restore__outcome,
.restore__note,
.restore__status {
  margin: 0;
  color: var(--text-muted);
  font-size: 0.85rem;
}

.restore__warn {
  margin: 0;
  color: var(--warning);
  font-size: 0.85rem;
}

.restore__error {
  margin: 0;
  color: var(--danger);
  font-size: 0.85rem;
}
</style>
