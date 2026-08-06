<script setup lang="ts">
// Whole-connection logical dump (ticket 0029, the web mirror of desktop
// ADR-0049). Desktop puts this behind a menu item that opens a save dialog
// and, for a large database, a confirmation modal; here the save dialog is
// the browser's own and the confirmation is inline, because the answer has
// to travel back to the server as a second request.
//
// It lives in the page header rather than the result toolbar: a dump is of
// the connection, not of whatever the grid happens to be showing.

import { computed } from "vue";
import { useI18n } from "vue-i18n";
import { useDump } from "../composables/useDump";
import { fromCategorised } from "../utils/display-error";

const props = defineProps<{ connectionId: string; apiBase?: string }>();

const { t } = useI18n();
const { state, lastError, pendingConfirm, start, dismiss } = useDump(props.connectionId, {
  apiBase: props.apiBase,
});

const isRunning = computed(() => state.value === "running");
const error = computed(() =>
  lastError.value ? fromCategorised(lastError.value, t).localized : null,
);
</script>

<template>
  <div class="dump" role="group" :aria-label="t('dump.label')">
    <button
      type="button"
      class="dump__button"
      data-testid="dump__download"
      :disabled="isRunning"
      @click="start()"
    >
      {{ isRunning ? t("dump.running") : t("dump.download") }}
    </button>

    <!-- Warn-and-allow (ADR-0049 Decision 8). The server's sentence names
         the row count, so it is shown next to the translated question
         rather than replaced by it. -->
    <p v-if="pendingConfirm" class="dump__confirm" data-testid="dump__confirm" role="alert">
      <span class="dump__confirm-text">{{ pendingConfirm }} {{ t("dump.confirm.prompt") }}</span>
      <button
        type="button"
        class="dump__button"
        data-testid="dump__confirm-accept"
        @click="start(true)"
      >
        {{ t("dump.confirm.accept") }}
      </button>
      <button
        type="button"
        class="dump__button"
        data-testid="dump__confirm-cancel"
        @click="dismiss()"
      >
        {{ t("dump.confirm.cancel") }}
      </button>
    </p>

    <p v-if="error" class="dump__error" data-testid="dump__error">{{ error }}</p>

    <!-- Rendered from the start, empty: a live region inserted at the same
         moment it gains text is not reliably announced. -->
    <span class="dump__status" data-testid="dump__status" role="status" aria-live="polite">{{
      isRunning ? t("dump.running") : ""
    }}</span>
  </div>
</template>

<style scoped>
.dump {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}

.dump__button {
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

.dump__button:hover:not(:disabled) {
  background: var(--surface-sunken);
}

.dump__button:disabled {
  cursor: default;
  opacity: 0.6;
}

.dump__confirm {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}

.dump__confirm-text {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.dump__error {
  margin: 0;
  color: var(--danger);
  font-size: 0.85rem;
}

.dump__status {
  color: var(--text-muted);
  font-size: 0.85rem;
}
</style>
