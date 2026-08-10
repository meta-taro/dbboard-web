<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useAiAssist } from "../composables/useAiAssist";
import { useAiProviders } from "../composables/useAiProviders";
import type { TableInfo } from "../composables/useSchemaBrowser";
import { fromCategorised } from "../utils/display-error";
import ErrorBanner from "./ErrorBanner.vue";

interface Props {
  currentSql: string;
  apiBase?: string;
  /**
   * The tables of the connection this panel is mounted beside, sent with a
   * suggest so the model names real ones (desktop ADR-0028 Decision 8).
   * The panel does not fetch them — it is handed them — which is what
   * keeps it as connection-agnostic as the composable behind it.
   *
   * Absent means the page could not offer a list at all, and the request
   * then carries no claim about tables. An empty array is a different
   * thing and is forwarded: the connection was read and has none.
   */
  tables?: readonly TableInfo[];
}

const props = defineProps<Props>();
const emit = defineEmits<{
  (event: "insert", text: string): void;
}>();

const { t } = useI18n();

const {
  providers,
  selected: selectedProvider,
  select: selectProvider,
  isDisabled: providersDisabled,
  selectedStreams,
  load: loadProviders,
} = useAiProviders({ apiBase: props.apiBase });

const hasChoice = computed(() => providers.value.length > 1);

const {
  lastResponse,
  state,
  lastError,
  tokensIn,
  tokensOut,
  wasCancelled,
  explain,
  suggestSql,
  streamExplain,
  streamSuggestSql,
  cancel,
} = useAiAssist({
  apiBase: props.apiBase,
  // Named only when there is a choice to record. One configured provider
  // is not a choice: rendering a select with a single option asks the
  // user to confirm something they cannot change, and putting its id on
  // the wire would make every Stage 1 deployment's requests change shape
  // for nothing the server can act on.
  provider: () => (hasChoice.value ? selectedProvider.value : undefined),
});

const dialect = ref("");
const prompt = ref("");
// Off by default, so a deployment that never touches the toggle behaves
// exactly as it did before this slice (ADR-0026 Decision 9).
const streamMode = ref(false);

// Asked once, when the panel appears. The list is only needed to render
// the selector — a request that names nobody still reaches the server's
// default — so a failure here leaves the panel usable rather than
// blocking it, and only `ai_disabled` changes what the panel shows.
onMounted(() => {
  void loadProviders();
});

const isLoading = computed(() => state.value === "loading");
const isStreaming = computed(() => state.value === "streaming");
const isBusy = computed(() => isLoading.value || isStreaming.value);
// `ai_disabled` is the documented Slice 2 signal that the provider isn't
// configured (env var unset). Retrying-on-click would just keep hitting
// the same 404, so we latch the UI into a neutral notice and disable
// both action buttons rather than rendering a generic error banner.
//
// Since slice B the same answer can arrive from `GET /ai/providers`
// before the user presses anything, which is the earliest the panel can
// know — either source latches the same notice.
const isDisabledMode = computed(
  () => providersDisabled.value || lastError.value?.category === "ai_disabled",
);
const buttonsDisabled = computed(() => isBusy.value || isDisabledMode.value);

const explainResponse = computed(() =>
  lastResponse.value?.mode === "explain" ? lastResponse.value : null,
);
const suggestResponse = computed(() =>
  lastResponse.value?.mode === "suggest" ? lastResponse.value : null,
);

// The toggle is checked *and* the provider behind it actually streams.
// Leaving the toggle out of the DOM is not enough on its own: switching
// to a provider without an SSE transport hides it while its ref stays
// true, and the request would still go to the streaming route.
const useStreaming = computed(() => streamMode.value && selectedStreams.value);

const hasTokens = computed(() => tokensIn.value !== null || tokensOut.value !== null);
const tokenParams = computed(() => ({
  tin: tokensIn.value ?? 0,
  tout: tokensOut.value ?? 0,
}));

const dialectArg = computed<string | undefined>(() => {
  const trimmed = dialect.value.trim();
  return trimmed === "" ? undefined : trimmed;
});

async function onExplain() {
  if (useStreaming.value) {
    await streamExplain(props.currentSql, dialectArg.value);
    return;
  }
  await explain(props.currentSql, dialectArg.value);
}

async function onSuggest() {
  if (useStreaming.value) {
    await streamSuggestSql(prompt.value, dialectArg.value, props.tables);
    return;
  }
  await suggestSql(prompt.value, dialectArg.value, props.tables);
}

// Bound with :value / @change rather than v-model so the selection stays
// owned by the composable, which is the half that knows which ids exist
// and refuses one that does not.
function onProviderChange(event: Event) {
  selectProvider((event.target as HTMLSelectElement).value);
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

    <ErrorBanner
      v-else-if="lastError"
      data-testid="ai-error"
      dense
      :error="fromCategorised(lastError, t)"
    />

    <div v-if="hasChoice" class="dialect-row">
      <label class="dialect-label" for="ai-provider">{{ t("ai.provider.label") }}</label>
      <select
        id="ai-provider"
        data-testid="ai-provider-select"
        class="dialect-input"
        :value="selectedProvider"
        :disabled="isBusy"
        @change="onProviderChange"
      >
        <option v-for="provider in providers" :key="provider.id" :value="provider.id">
          {{ provider.name }}
        </option>
      </select>
    </div>

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

    <!--
      Only for a provider that answers the streaming routes chunk by
      chunk (ADR-0026 Decision 8). Every provider answers them, so an
      ungated toggle would promise an answer arriving in pieces and, for
      some of them, deliver it all at once.
    -->
    <div v-if="selectedStreams" class="toggle-row">
      <input
        id="ai-stream"
        v-model="streamMode"
        data-testid="ai-stream-toggle"
        class="toggle-input"
        type="checkbox"
        :disabled="isBusy"
      />
      <label class="toggle-label" for="ai-stream">{{ t("ai.stream.toggle") }}</label>
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
      <p v-if="!explainResponse && !isBusy" data-testid="ai-explain-empty" class="empty">
        {{ t("ai.explain.empty") }}
      </p>
      <article v-if="explainResponse" data-testid="ai-explain-output" class="output">
        <pre class="output-text">{{ explainResponse.text }}</pre>
        <!-- Empty until message_start names it, which is one frame into a
             stream — so the line waits rather than showing a blank model. -->
        <p v-if="explainResponse.model" class="output-model">
          {{ t("ai.response.model", { model: explainResponse.model }) }}
        </p>
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
      <p v-if="!suggestResponse && !isBusy" data-testid="ai-suggest-empty" class="empty">
        {{ t("ai.suggest.empty") }}
      </p>
      <article v-if="suggestResponse" data-testid="ai-suggest-output" class="output">
        <pre class="output-text">{{ suggestResponse.text }}</pre>
        <p v-if="suggestResponse.model" class="output-model">
          {{ t("ai.response.model", { model: suggestResponse.model }) }}
        </p>
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

    <p v-if="hasTokens" data-testid="ai-token-meter" class="meter">
      {{ t("ai.tokens.meter", tokenParams) }}
    </p>

    <!--
      Cancelling is not failing (ADR-0026 Decision 12): its own line, no
      banner, and whatever arrived before the stop stays above it.
    -->
    <p v-if="wasCancelled" data-testid="ai-cancelled" class="loading" role="status">
      {{ t("ai.state.cancelled") }}
    </p>

    <div v-if="isBusy" class="status-row">
      <p data-testid="ai-loading" class="loading">{{ t("ai.state.loading") }}</p>
      <!--
        Offered while a stream runs and not during an atomic call: there
        the request is already in flight behind `fetch`, with nothing a
        click could stop (ADR-0026 Decision 10, as far as web can honour
        it).
      -->
      <button
        v-if="isStreaming"
        type="button"
        data-testid="ai-cancel-button"
        class="insert-button"
        @click="cancel"
      >
        {{ t("ai.cancel.button") }}
      </button>
    </div>
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

.dialect-row {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.dialect-label {
  font-size: 0.85rem;
  font-weight: 600;
}

.toggle-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.toggle-input {
  width: 1rem;
  height: 1rem;
}

.toggle-label {
  font-size: 0.85rem;
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

.status-row {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.meter {
  margin: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}
</style>
