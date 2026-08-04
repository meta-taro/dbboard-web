<script setup lang="ts">
// Read-only viewer for a cell value the grid could not show in full
// (desktop ADR-0082 decision 5). Opening is the grid's decision — see
// `needsViewer` in app/utils/display-width.ts; this component only renders.
//
// Desktop's counterpart is the read-only half of ResultGrid.svelte's popup.
// Two things are web-specific and deliberate: the copy is acknowledged in a
// live region (a copy leaves nothing on screen to notice — the same reason
// ResultExportToolbar has one), and there is a visible close button, because
// Escape does not exist on a phone and a backdrop nobody knows to tap is not
// a way out.

import { ref } from "vue";
import { useI18n } from "vue-i18n";

defineProps<{ column: string; value: string }>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const status = ref("");

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value);
    status.value = t("result.viewer.copied");
  } catch {
    // Denied permission and an insecure context both land here, and both
    // are the user's to resolve — saying nothing would read as success.
    status.value = t("result.viewer.failed");
  }
}
</script>

<template>
  <div
    data-testid="cell-viewer"
    class="backdrop"
    role="presentation"
    tabindex="-1"
    @click="emit('close')"
    @keydown.escape="emit('close')"
  >
    <!-- The panel swallows its own clicks: selecting the text means dragging
         across it, and a click bubbling out would close what is being read. -->
    <div
      class="panel"
      role="dialog"
      aria-modal="true"
      :aria-label="t('result.viewer.label')"
      @click.stop
    >
      <header class="head">
        <span data-testid="cell-viewer__column" class="column">{{ column }}</span>
        <div class="actions">
          <button type="button" data-testid="cell-viewer__copy" class="ghost" @click="copy(value)">
            {{ t("result.viewer.copy") }}
          </button>
          <button
            type="button"
            data-testid="cell-viewer__close"
            class="ghost"
            @click="emit('close')"
          >
            {{ t("result.viewer.close") }}
          </button>
        </div>
      </header>
      <pre data-testid="cell-viewer__body" class="body">{{ value }}</pre>
      <p data-testid="cell-viewer__status" class="status" role="status" aria-live="polite">
        {{ status }}
      </p>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 10;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  background: var(--scrim);
}

.panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
  width: min(720px, 100%);
  max-height: 80vh;
  padding: 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-raised);
  color: var(--text);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.column {
  font-weight: 600;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.actions {
  display: flex;
  gap: 8px;
}

.ghost {
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.ghost:hover {
  background: var(--surface-sunken);
}

.ghost:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.body {
  /* The value is why the dialog exists: it wraps rather than scrolling
     sideways, and keeps its own line breaks. */
  margin: 0;
  overflow: auto;
  padding: 8px;
  border: 1px solid var(--border-faint);
  border-radius: 4px;
  background: var(--surface-sunken);
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9rem;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.status {
  /* Rendered from the start and empty: a live region that appears at the
     same moment it gains text is not reliably announced. */
  min-height: 1.2em;
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}
</style>
