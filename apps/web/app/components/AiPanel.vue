<script setup lang="ts">
import { computed, ref } from "vue";
import { useAiAssist } from "../composables/useAiAssist";

interface Props {
  currentSql: string;
  apiBase?: string;
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: "insert", text: string): void;
}>();

const { t } = useI18n();
const { lastResponse, state, lastError, explain, suggestSql } = useAiAssist({
  apiBase: props.apiBase,
});

const dialect = ref("");
const prompt = ref("");

const isLoading = computed(() => state.value === "loading");
// `ai_disabled` is the documented Slice 2 signal that the provider isn't
// configured (env var unset). Retrying-on-click would just keep hitting
// the same 404, so we latch the UI into a neutral notice and disable
// both action buttons rather than rendering a generic error banner.
const isDisabledMode = computed(() => lastError.value?.category === "ai_disabled");
const buttonsDisabled = computed(() => isLoading.value || isDisabledMode.value);

const explainResponse = computed(() =>
  lastResponse.value?.mode === "explain" ? lastResponse.value : null,
);
const suggestResponse = computed(() =>
  lastResponse.value?.mode === "suggest" ? lastResponse.value : null,
);

const dialectArg = computed<string | undefined>(() => {
  const trimmed = dialect.value.trim();
  return trimmed === "" ? undefined : trimmed;
});

async function onExplain() {
  await explain(props.currentSql, dialectArg.value);
}

async function onSuggest() {
  await suggestSql(prompt.value, dialectArg.value);
}

function onInsert() {
  if (suggestResponse.value === null) return;
  emit("insert", suggestResponse.value.text);
}
</script>

<template>
  <aside data-testid="ai-panel" class="ai-panel">
    <header class="header">
      <h3 class="title">{{ t("ai.heading") }}</h3>
    </header>

    <div v-if="isDisabledMode" data-testid="ai-disabled-notice" class="disabled-notice">
      <p class="disabled-heading">{{ t("ai.disabled.heading") }}</p>
      <p class="disabled-body">{{ t("ai.disabled.body") }}</p>
    </div>

    <p v-else-if="lastError" data-testid="ai-error" role="alert" class="error-banner">
      {{ t(lastError.i18nKey) }}: {{ lastError.message }}
    </p>

    <div class="dialect-row">
      <label class="dialect-label" for="ai-dialect">{{ t("ai.dialect.label") }}</label>
      <input
        id="ai-dialect"
        v-model="dialect"
        data-testid="ai-dialect-input"
        class="dialect-input"
        type="text"
        :placeholder="t('ai.dialect.placeholder')"
        autocomplete="off"
      />
    </div>

    <section data-testid="ai-explain-section" class="section">
      <h4 class="section-heading">{{ t("ai.section.explain") }}</h4>
      <button
        type="button"
        data-testid="ai-explain-button"
        class="action-button"
        :disabled="buttonsDisabled"
        @click="onExplain"
      >
        {{ t("ai.explain.button") }}
      </button>
      <p v-if="!explainResponse && !isLoading" data-testid="ai-explain-empty" class="empty">
        {{ t("ai.explain.empty") }}
      </p>
      <article v-if="explainResponse" data-testid="ai-explain-output" class="output">
        <pre class="output-text">{{ explainResponse.text }}</pre>
        <p class="output-model">{{ t("ai.response.model", { model: explainResponse.model }) }}</p>
      </article>
    </section>

    <section data-testid="ai-suggest-section" class="section">
      <h4 class="section-heading">{{ t("ai.section.suggest") }}</h4>
      <label class="prompt-label" for="ai-suggest-prompt">
        {{ t("ai.suggest.prompt-label") }}
      </label>
      <textarea
        id="ai-suggest-prompt"
        v-model="prompt"
        data-testid="ai-suggest-prompt"
        class="prompt-input"
        rows="3"
        spellcheck="false"
        autocomplete="off"
        :placeholder="t('ai.suggest.prompt-placeholder')"
      />
      <button
        type="button"
        data-testid="ai-suggest-button"
        class="action-button"
        :disabled="buttonsDisabled"
        @click="onSuggest"
      >
        {{ t("ai.suggest.button") }}
      </button>
      <p v-if="!suggestResponse && !isLoading" data-testid="ai-suggest-empty" class="empty">
        {{ t("ai.suggest.empty") }}
      </p>
      <article v-if="suggestResponse" data-testid="ai-suggest-output" class="output">
        <pre class="output-text">{{ suggestResponse.text }}</pre>
        <p class="output-model">{{ t("ai.response.model", { model: suggestResponse.model }) }}</p>
        <button
          type="button"
          data-testid="ai-suggest-insert"
          class="insert-button"
          @click="onInsert"
        >
          {{ t("ai.suggest.insert") }}
        </button>
      </article>
    </section>

    <p v-if="isLoading" data-testid="ai-loading" class="loading">{{ t("ai.state.loading") }}</p>
  </aside>
</template>

<style scoped>
.ai-panel {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  padding: 0.75rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
}

.header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.title {
  margin: 0;
  font-size: 1rem;
}

.disabled-notice {
  padding: 0.75rem 1rem;
  border-radius: 4px;
  background: var(--muted-tint);
  border: 1px solid var(--muted-tint-border);
  color: var(--text-muted);
  font-size: 0.9rem;
}

.disabled-heading {
  margin: 0 0 0.25rem;
  font-weight: 600;
}

.disabled-body {
  margin: 0;
  font-size: 0.85rem;
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

.dialect-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.dialect-label {
  font-size: 0.85rem;
  font-weight: 600;
}

.dialect-input {
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: 4px;
}

.section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding-top: 0.5rem;
  border-top: 1px solid var(--border);
}

.section-heading {
  margin: 0;
  font-size: 0.95rem;
}

.action-button {
  min-height: 44px;
  padding: 0 1rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 0.9rem;
  cursor: pointer;
  align-self: flex-start;
}

.action-button:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.action-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.prompt-label {
  font-size: 0.85rem;
  font-weight: 600;
}

.prompt-input {
  width: 100%;
  box-sizing: border-box;
  min-height: 44px;
  padding: 0.5rem 0.75rem;
  font-size: 0.95rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  resize: vertical;
}

.empty {
  margin: 0;
  color: var(--text-muted);
  font-style: italic;
  font-size: 0.85rem;
}

.output {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  padding: 0.5rem 0.75rem;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface-sunken);
}

.output-text {
  margin: 0;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 0.85rem;
  white-space: pre-wrap;
  word-break: break-word;
}

.output-model {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
}

.insert-button {
  min-height: 36px;
  padding: 0 0.75rem;
  border-radius: 4px;
  border: 1px solid var(--accent);
  background: transparent;
  color: var(--accent);
  font-size: 0.85rem;
  cursor: pointer;
  align-self: flex-start;
}

.insert-button:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}

.loading {
  margin: 0;
  color: var(--text-muted);
  font-style: italic;
  font-size: 0.85rem;
}
</style>
