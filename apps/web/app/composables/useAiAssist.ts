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
import type { TableInfo } from "./useSchemaBrowser";

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
  /**
   * Which configured provider should answer (ticket 0032 slice B). An
   * option rather than an argument to explain() / suggestSql(): the
   * selection is one piece of panel state applied to both calls, not
   * something a caller decides per request.
   *
   * A getter, not a value, so changing the selector does not mean
   * rebuilding the composable and losing the response already on
   * screen. Returning undefined omits the field, and the server falls
   * back to its own default — which is the request every deployment
   * made before this option existed.
   */
  provider?: () => string | undefined;
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
    // Read at call time, not at setup time: the selector is live.
    const provider = options?.provider?.();
    if (provider !== undefined) body.provider = provider;
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

  /**
   * `schema` is the table list the caller introspected (desktop ADR-0028
   * Decision 8). Passing `[]` is a claim — "we looked, there are none" —
   * and reaches the prompt; passing nothing omits the key, which is what
   * a caller with no connection open does and what keeps this call
   * identical to the one made before the field existed.
   */
  async function suggestSql(
    prompt: string,
    dialect?: string,
    schema?: readonly TableInfo[],
  ): Promise<void> {
    const body: Record<string, unknown> = { prompt };
    if (dialect !== undefined) body.dialect = dialect;
    if (schema !== undefined) body.schema = schema;
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
