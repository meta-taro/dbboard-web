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
import { parseError, toI18nKey, type CategorisedError } from "./internal/i18n-error";
import { openSseStream } from "./internal/sse";
import type { TableInfo, TableSchema } from "./useSchemaBrowser";

// "streaming" is distinct from "loading" because the two look different
// on screen: a loading call has nothing to show, a streaming one has a
// partial answer and a Cancel button (ADR-0026 Decisions 9 and 10).
export type AiState = "idle" | "loading" | "streaming" | "error";

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

/**
 * The wire twin of the API's `StreamEvent` union (ADR-0026 Decision 3).
 * Restated here rather than imported because the two apps share no
 * package — the same reason `WireAiResponse` is restated. The API's
 * `ai-routes.integration.spec.ts` is what keeps the two in step.
 */
type WireStreamEvent =
  | { type: "message_start"; tokensIn: number | null; model: string | null }
  | { type: "text_delta"; text: string }
  | { type: "usage"; tokensIn: number | null; tokensOut: number | null }
  | { type: "message_stop"; stopReason: string | null }
  | { type: "error"; category: string; message: string };

function asStreamEvent(raw: unknown): WireStreamEvent | null {
  // A frame we cannot read is dropped rather than thrown on: the rest of
  // the answer is still arriving, and a newer server may well be sending
  // a variant this build predates.
  if (typeof raw !== "object" || raw === null) return null;
  const type = (raw as { type?: unknown }).type;
  return typeof type === "string" ? (raw as WireStreamEvent) : null;
}

/**
 * The suggest body, built once for both the atomic and the streaming
 * route. Shared rather than duplicated because the two routes validate
 * against the same DTO: a field added to one and forgotten on the other
 * would be a difference only a streaming user ever hit.
 */
function suggestBody(
  prompt: string,
  dialect: string | undefined,
  schema: readonly TableInfo[] | undefined,
  fullSchema: readonly TableSchema[] | undefined,
): Record<string, unknown> {
  const body: Record<string, unknown> = { prompt };
  if (dialect !== undefined) body.dialect = dialect;
  if (schema !== undefined) body.schema = schema;
  if (fullSchema !== undefined) body.full_schema = fullSchema;
  return body;
}

/**
 * One `stream*` invocation. `cancelled` lives here rather than in a
 * composable-level ref so a run that is aborted to make way for a newer
 * one cannot report *that* as the user cancelling, and so the identity
 * check (`current === run`) can keep a superseded run from writing to
 * state the new one has already reset.
 */
interface StreamRun {
  controller: AbortController;
  cancelled: boolean;
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
  const tokensIn = ref<number | null>(null);
  const tokensOut = ref<number | null>(null);
  const wasCancelled = ref(false);
  let current: StreamRun | null = null;

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
   *
   * `fullSchema` is the described half (ADR-0028 Decision 9) — a fourth
   * argument rather than a replacement for the third, because both halves
   * travel together and the terse list is what the API falls back to when
   * the prefetch came back with nothing. An empty list is forwarded as an
   * empty list for that reason: "every table failed to describe" is the
   * server's fallback to decide, not a shape the browser rewrites into
   * "we never asked".
   */
  async function suggestSql(
    prompt: string,
    dialect?: string,
    schema?: readonly TableInfo[],
    fullSchema?: readonly TableSchema[],
  ): Promise<void> {
    await call("/ai/suggest", suggestBody(prompt, dialect, schema, fullSchema), "suggest");
  }

  function apply(event: WireStreamEvent): void {
    const previous = lastResponse.value;
    switch (event.type) {
      case "message_start":
        if (event.tokensIn !== null) tokensIn.value = event.tokensIn;
        if (event.model !== null && previous !== null) {
          lastResponse.value = { ...previous, model: event.model };
        }
        return;
      case "text_delta":
        if (previous !== null) {
          lastResponse.value = { ...previous, text: previous.text + event.text };
        }
        return;
      case "usage":
        // Cumulative, so each report replaces the meter (ADR-0026
        // Decision 7). Adding them would double a two-report answer, and
        // the wrong number would look entirely plausible.
        if (event.tokensIn !== null) tokensIn.value = event.tokensIn;
        if (event.tokensOut !== null) tokensOut.value = event.tokensOut;
        return;
      case "error":
        // The event's own category says *how* the upstream call failed
        // (network / provider / configuration); the panel shows the same
        // banner for all three, which on the atomic path is the API's
        // `ai_provider`. Keeping the finer category would mean three
        // locale strings that read alike and never diverge.
        lastError.value = {
          category: "ai_provider",
          message: event.message,
          i18nKey: toI18nKey("ai_provider"),
        };
        state.value = "error";
        return;
      case "message_stop":
        // Terminus only. The loop ending is what moves the state.
        return;
    }
  }

  async function stream(path: string, body: Record<string, unknown>, mode: AiMode): Promise<void> {
    // A second Send while one is running replaces it rather than racing
    // it — the panel has one output area, so two live streams could only
    // interleave into it.
    cancel();
    const run: StreamRun = { controller: new AbortController(), cancelled: false };
    current = run;

    lastError.value = null;
    wasCancelled.value = false;
    tokensIn.value = null;
    tokensOut.value = null;
    // Seeded empty rather than left null so the panel can render the
    // answer as it grows without a separate "partial" slot. `model` is
    // filled in by message_start.
    lastResponse.value = { text: "", model: "", mode };
    state.value = "streaming";

    const provider = options?.provider?.();
    if (provider !== undefined) body.provider = provider;

    try {
      for await (const raw of openSseStream(`${apiBase}${path}`, {
        body,
        signal: run.controller.signal,
      })) {
        if (current !== run) return;
        const event = asStreamEvent(raw);
        if (event !== null) apply(event);
      }
      if (current !== run) return;
      if (state.value === "streaming") state.value = "idle";
    } catch (err: unknown) {
      if (current !== run) return;
      if (run.cancelled) {
        // Cancelling is not failing (ADR-0026 Decision 12): no banner,
        // and whatever arrived before the stop stays on screen.
        wasCancelled.value = true;
        state.value = "idle";
        return;
      }
      lastError.value = parseError(err);
      state.value = "error";
    } finally {
      if (current === run) current = null;
    }
  }

  /**
   * Stops the stream in flight, if any. Idempotent and safe to call when
   * nothing is running, because the panel enables Cancel for the whole
   * time the composable is busy (ADR-0026 Decision 10) and a click can
   * always land just after the last event.
   */
  function cancel(): void {
    if (current === null) return;
    current.cancelled = true;
    current.controller.abort();
  }

  async function streamExplain(sql: string, dialect?: string): Promise<void> {
    const body: Record<string, unknown> = { sql };
    if (dialect !== undefined) body.dialect = dialect;
    await stream("/ai/explain/stream", body, "explain");
  }

  async function streamSuggestSql(
    prompt: string,
    dialect?: string,
    schema?: readonly TableInfo[],
    fullSchema?: readonly TableSchema[],
  ): Promise<void> {
    await stream("/ai/suggest/stream", suggestBody(prompt, dialect, schema, fullSchema), "suggest");
  }

  return {
    lastResponse: readonly(lastResponse),
    state: readonly(state),
    lastError: readonly(lastError),
    tokensIn: readonly(tokensIn),
    tokensOut: readonly(tokensOut),
    wasCancelled: readonly(wasCancelled),
    explain,
    suggestSql,
    streamExplain,
    streamSuggestSql,
    cancel,
  };
}
