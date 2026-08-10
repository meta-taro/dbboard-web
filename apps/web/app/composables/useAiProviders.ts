/**
 * Backs the provider selector in the AI panel (ticket 0032 slice B).
 * Wraps `GET /ai/providers`, whose body is `{ providers: [...] }`.
 *
 * Desktop keeps its provider list in a settings window that also takes
 * the API key. Web has no such window and cannot have one: baseline §15
 * puts credentials in human hands and out of the application's, so the
 * list is whatever the operator put in the environment. What survives
 * the mirror is not the settings UI but the thing it existed to
 * produce — more than one provider, and a way to say which answers.
 *
 * Kept separate from useAiAssist because the two have different
 * lifetimes: this is asked once when the panel appears, that is asked
 * every time the user presses a button, and a failure of one should not
 * put the other into an error state.
 */
import { computed, readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export type AiProvidersState = "idle" | "loading" | "error";

export interface AiProviderDescriptor {
  id: string;
  name: string;
  kind: string;
  model: string;
  default: boolean;
}

interface WireProvidersResponse {
  providers: AiProviderDescriptor[];
}

export interface UseAiProvidersOptions {
  apiBase?: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useAiProviders(options?: UseAiProvidersOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const providers = ref<AiProviderDescriptor[]>([]);
  const selected = ref<string | undefined>(undefined);
  const state = ref<AiProvidersState>("idle");
  const lastError = ref<CategorisedError | null>(null);
  const disabled = ref(false);

  async function load(): Promise<void> {
    state.value = "loading";
    try {
      const res = await apiFetch<WireProvidersResponse>(`${apiBase}/ai/providers`);
      providers.value = res.providers;
      // The server's default, not the first entry: the selection shown
      // has to agree with what the server would pick for a request that
      // names nobody, or the panel would display one provider and the
      // first call would reach another.
      selected.value = (res.providers.find((p) => p.default) ?? res.providers[0])?.id;
      disabled.value = false;
      lastError.value = null;
      state.value = "idle";
    } catch (err: unknown) {
      const parsed = parseError(err);
      if (parsed.category === "ai_disabled") {
        // Not an error. A deployment without AI is a configuration the
        // panel renders a neutral notice for, and it is the same answer
        // the two call routes give — learned here before the user
        // presses anything rather than after a failed explain.
        disabled.value = true;
        providers.value = [];
        selected.value = undefined;
        lastError.value = null;
        state.value = "idle";
        return;
      }
      lastError.value = parsed;
      state.value = "error";
    }
  }

  /**
   * Ignores an id this deployment does not have. The server answers 422
   * for an unknown name, so accepting one here would only move a failure
   * from the selector to the next call — this keeps the selection unable
   * to describe a state the server would reject.
   */
  function select(id: string): void {
    if (!providers.value.some((p) => p.id === id)) return;
    selected.value = id;
  }

  return {
    providers: readonly(providers),
    selected: readonly(selected),
    state: readonly(state),
    lastError: readonly(lastError),
    isDisabled: computed(() => disabled.value),
    load,
    select,
  };
}
