<script setup lang="ts">
// Copy / Save, mirroring desktop ADR-0035's export toolbar. Serialization is
// pure (utils/export.ts) and the I/O is in useResultExport; this component is
// only the two controls and the acknowledgement.
//
// It sits above the grid rather than inside it: the grid's root element is the
// virtualizer's scroll container and has to keep its own height.

import { useI18n } from "vue-i18n";
import type { QueryResult } from "../composables/useQueryExecution";
import { useResultExport } from "../composables/useResultExport";

const props = defineProps<{ result: QueryResult }>();

const { t } = useI18n();
const { state, copyTsv, downloadCsv } = useResultExport();

/**
 * Not localized, and not timestamped. Desktop derives the same stem, and a
 * stable name is what makes a repeated export overwrite the previous file
 * instead of littering the download folder — the browser's own de-duplication
 * handles the case where the user wants to keep both.
 */
const DOWNLOAD_FILENAME = "dbboard-result.csv";

function onCopy() {
  void copyTsv(props.result.columns, props.result.rows);
}

function onDownload() {
  downloadCsv(props.result.columns, props.result.rows, DOWNLOAD_FILENAME);
}
</script>

<template>
  <div class="export-toolbar" role="toolbar" :aria-label="t('result.export.label')">
    <button
      type="button"
      class="export-toolbar__button"
      data-testid="result-export__copy"
      @click="onCopy"
    >
      {{ t("result.export.copy") }}
    </button>
    <button
      type="button"
      class="export-toolbar__button"
      data-testid="result-export__download"
      @click="onDownload"
    >
      {{ t("result.export.download") }}
    </button>
    <!-- Rendered from the start, empty: a live region inserted at the same
         moment it gains text is not reliably announced. -->
    <span
      class="export-toolbar__status"
      :class="{ 'export-toolbar__status--failed': state === 'failed' }"
      data-testid="result-export__status"
      role="status"
      aria-live="polite"
      >{{ state === "idle" ? "" : t(`result.export.${state}`) }}</span
    >
  </div>
</template>

<style scoped>
.export-toolbar {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}

.export-toolbar__button {
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

.export-toolbar__button:hover {
  background: var(--surface-sunken);
}

.export-toolbar__status {
  color: var(--text-muted);
  font-size: 0.85rem;
}

.export-toolbar__status--failed {
  color: var(--danger);
}
</style>
