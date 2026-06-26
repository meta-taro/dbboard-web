/**
 * Backs the Phase 6 Slice 3 AI panel (issue 0022). Thin wrapper over
 * `POST /ai/explain` and `POST /ai/suggest` (Slice 2 wire shape).
 *
 * Connection-agnostic — the AI routes operate on free-form SQL or a
 * natural-language prompt, never on a connection identifier (the user
 * may want to draft a query without an open connection). State is
 * shared across both methods because the panel renders a single
 * spinner / error banner / response area.
 *
 * The `mode` discriminator on `lastResponse` is web-side bookkeeping
 * so the panel can route the response to the correct output slot; the
 * wire body itself is `{text, model}` per AiResponse in the API port.
 */
import { readonly, ref } from "vue";
import { useRuntimeConfig } from "#imports";
import { apiFetch } from "./internal/http";
import { parseError, type CategorisedError } from "./internal/i18n-error";

export type AiState = "idle" | "loading" | "error";

export type AiMode = "explain" | "suggest";

export interface AiResponseWithMode {
  text: string;
  model: string;
  mode: AiMode;
}

interface WireAiResponse {
  text: string;
  model: string;
}

export interface UseAiAssistOptions {
  apiBase?: string;
}

function resolveApiBase(explicit: string | undefined): string {
  if (explicit !== undefined) return explicit;
  const cfg = useRuntimeConfig();
  return cfg.public.apiBaseUrl ?? "";
}

export function useAiAssist(options?: UseAiAssistOptions) {
  const apiBase = resolveApiBase(options?.apiBase);
  const lastResponse = ref<AiResponseWithMode | null>(null);
  const state = ref<AiState>("idle");
  const lastError = ref<CategorisedError | null>(null);

  async function call(path: string, body: Record<string, unknown>, mode: AiMode): Promise<void> {
    state.value = "loading";
    try {
      const res = await apiFetch<WireAiResponse>(`${apiBase}${path}`, {
        method: "POST",
        body,
      });
      lastResponse.value = { text: res.text, model: res.model, mode };
      state.value = "idle";
      lastError.value = null;
    } catch (err: unknown) {
      lastError.value = parseError(err);
      state.value = "error";
    }
  }

  async function explain(sql: string, dialect?: string): Promise<void> {
    const body: Record<string, unknown> = { sql };
    if (dialect !== undefined) body.dialect = dialect;
    await call("/ai/explain", body, "explain");
  }

  async function suggestSql(prompt: string, dialect?: string): Promise<void> {
    const body: Record<string, unknown> = { prompt };
    if (dialect !== undefined) body.dialect = dialect;
    await call("/ai/suggest", body, "suggest");
  }

  return {
    lastResponse: readonly(lastResponse),
    state: readonly(state),
    lastError: readonly(lastError),
    explain,
    suggestSql,
  };
}
