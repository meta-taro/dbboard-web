<script setup lang="ts">
// The one way this app puts an error on screen (desktop ADR-0039's
// `render_error`): the localized message, a copy button, and — only when it
// says something the first line does not — the English original, dimmed.
//
// Before this existed, five call sites each hand-assembled `prefix: message`
// and each carried its own copy of the same banner CSS. The English half was
// nowhere, so an error a user could not read was also an error they could not
// search for.
//
// The copy acknowledgement is a sibling of the alert, not inside it. Text
// changing inside a `role="alert"` re-announces the whole alert, so a screen
// reader would hear the error again every time the button is pressed.

import { ref } from "vue";
import { useI18n } from "vue-i18n";
import { errorClipboardText, hasOriginal, type DisplayError } from "../utils/display-error";

const props = defineProps<{
  error: DisplayError;
  /** Tighter type and padding, for a banner inside a sidebar or a panel. */
  dense?: boolean;
}>();

const { t } = useI18n();
const status = ref("");

async function copy() {
  try {
    await navigator.clipboard.writeText(errorClipboardText(props.error));
    status.value = t("error.copied");
  } catch {
    // Denied permission and an insecure context both land here, and both are
    // the user's to resolve — saying nothing would read as success.
    status.value = t("error.copy-failed");
  }
}
</script>

<template>
  <div class="wrap">
    <div class="banner" :class="{ 'banner--dense': dense }" role="alert">
      <div class="lines">
        <p class="localized">{{ error.localized }}</p>
        <!-- An English UI translates to itself; a second identical line reads
             as a bug, and this one is meant to add something. -->
        <p v-if="hasOriginal(error)" data-testid="error-banner__original" class="original">
          {{ error.original }}
        </p>
      </div>
      <button
        type="button"
        data-testid="error-banner__copy"
        class="copy"
        :class="{ 'copy--dense': dense }"
        @click="copy"
      >
        {{ t("error.copy") }}
      </button>
    </div>
    <p data-testid="error-banner__status" class="status" role="status" aria-live="polite">
      {{ status }}
    </p>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
}

.banner {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  padding: 0.75rem 1rem;
  border: 1px solid var(--danger-tint-border);
  border-radius: 4px;
  background: var(--danger-tint);
  color: var(--danger-text);
}

.banner--dense {
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
}

.lines {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.localized,
.original {
  margin: 0;
  /* An engine's error can be one long line with no spaces in it. */
  overflow-wrap: anywhere;
}

.original {
  /* Dimmed rather than hidden behind a toggle: it is the half that can be
     searched, and one click away is far enough to never be found. */
  opacity: 0.75;
  font-size: 0.85em;
}

.copy {
  flex: none;
  height: 32px;
  padding: 0 12px;
  border: 1px solid var(--danger-tint-border);
  border-radius: 4px;
  background: none;
  color: inherit;
  font: inherit;
  cursor: pointer;
}

.copy--dense {
  height: 26px;
  padding: 0 8px;
}

.copy:hover {
  background: var(--danger-tint);
}

.copy:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}

.status {
  /* Rendered from the start and empty: a live region that appears at the same
     moment it gains text is not reliably announced. */
  min-height: 1.2em;
  margin: 0;
  color: var(--text-muted);
  font-size: 0.8rem;
}
</style>
