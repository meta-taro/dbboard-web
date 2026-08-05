<script setup lang="ts">
// The full editor for a cell value the inline input cannot hold — a value
// wider than the column could show, or one with newlines in it (ticket 0028
// slice E, desktop ADR-0042/0063). Which of the two editors opens is the
// grid's decision, made by `needsWideEditor` in app/utils/display-width.ts;
// this component only edits.
//
// Deliberately the read-only viewer's twin (CellViewer.vue): the same
// backdrop, the same panel, the same way out. A user who has opened one of
// them has learned both, and the two differ only where they must — a
// `<textarea>` instead of a `<pre>`, and a footer that can commit.
//
// It owns its draft rather than binding the grid's. The grid learns the text
// on apply and never before, which is what makes cancelling free: a dialog
// opened by accident must not be able to stage an edit on its way out.

import { ref } from "vue";
import { useI18n } from "vue-i18n";

const props = defineProps<{ column: string; value: string }>();
const emit = defineEmits<{ apply: [string]; setNull: []; cancel: [] }>();

const { t } = useI18n();
const draft = ref(props.value);

// Characters, not UTF-16 units: a `varchar(500)` limit counts the same way,
// so the number shown is the one the column actually constrains.
function charCount(text: string): number {
  return [...text].length;
}

// Enter inserts a newline in a textarea — which is half the reason this
// dialog exists — so committing needs a modifier.
function onKeydown(event: KeyboardEvent) {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    emit("apply", draft.value);
  }
}
</script>

<template>
  <div
    data-testid="cell-editor"
    class="backdrop"
    role="presentation"
    tabindex="-1"
    @click="emit('cancel')"
    @keydown.escape="emit('cancel')"
  >
    <!-- The panel swallows its own clicks: selecting text means dragging
         across it, and a click bubbling out would discard what is being
         written. -->
    <div
      class="panel"
      role="dialog"
      aria-modal="true"
      :aria-label="t('result.edit.dialog-label')"
      @click.stop
    >
      <header class="head">
        <span data-testid="cell-editor__column" class="column">{{ column }}</span>
        <span data-testid="cell-editor__chars" class="chars">{{
          t("result.edit.chars", { count: charCount(draft) })
        }}</span>
      </header>
      <textarea
        v-model="draft"
        data-testid="cell-editor__input"
        class="body"
        spellcheck="false"
        :aria-label="t('result.edit.dialog-label')"
        @keydown="onKeydown"
      />
      <footer class="foot">
        <button
          type="button"
          data-testid="cell-editor__null"
          class="ghost"
          :title="t('result.edit.null-title')"
          @click="emit('setNull')"
        >
          ∅ NULL
        </button>
        <span class="hint">{{ t("result.edit.dialog-hint") }}</span>
        <button
          type="button"
          data-testid="cell-editor__cancel"
          class="ghost"
          @click="emit('cancel')"
        >
          {{ t("result.edit.cancel") }}
        </button>
        <button
          type="button"
          data-testid="cell-editor__apply"
          class="primary"
          @click="emit('apply', draft)"
        >
          {{ t("result.edit.apply") }}
        </button>
      </footer>
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

.chars {
  color: var(--text-muted);
  font-size: 0.8rem;
}

.body {
  /* The value is why the dialog exists: it gets the room the cell did not,
     and the user gets to resize it. */
  min-height: 40vh;
  padding: 8px;
  border: 1px solid var(--border-faint);
  border-radius: 4px;
  background: var(--surface-sunken);
  color: inherit;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.9rem;
  resize: vertical;
}

.body:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.foot {
  display: flex;
  align-items: center;
  gap: 8px;
}

.hint {
  /* Pushes the two commit buttons to the right, away from ∅ NULL — which is
     destructive, and should not sit where the eye expects "Apply". */
  flex: 1 1 auto;
  color: var(--text-muted);
  font-size: 0.8rem;
}

.ghost,
.primary {
  height: 32px;
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

.ghost:focus-visible,
.primary:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
</style>
