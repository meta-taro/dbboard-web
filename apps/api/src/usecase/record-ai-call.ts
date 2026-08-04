import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import type { AiProvider, AiResponse } from "../domain/ai/ai-provider.port";
import type { AiRecordContext, RecordHistory } from "./record-history.use-case";

// The shared body of every AI use case: resolve the provider, time the
// call, translate failures to the wire taxonomy, and write a history
// v:2 `kind: "ai"` record. ExplainSql and SuggestSql differ only in
// which provider method they call and what counts as the prompt, so the
// logic lives here — that way the two intents cannot drift apart in
// what they record.
//
// Recording is best-effort, mirroring HistoryRecordingInterceptor: a
// thrown recorder is swallowed so a buggy mapper never breaks a
// user-facing request.

export interface AiCallSpec {
  intent: AiRecordContext["intent"];
  // What the user asked, stored verbatim as the record's `prompt`.
  prompt: string;
  invoke: (provider: AiProvider) => Promise<AiResponse>;
}

export async function runRecordedAiCall(
  provider: AiProvider | undefined,
  history: RecordHistory,
  spec: AiCallSpec,
  nowMs: () => number,
): Promise<AiResponse> {
  if (provider === undefined) {
    // Nothing to record: no provider was called, so there is no
    // `provider` or `model` to name and the schema requires both. The
    // absence of a configured provider is a deployment fact, not an AI
    // call outcome.
    throw new AiDisabledError("AI provider is not configured");
  }

  const ctx: AiRecordContext = {
    intent: spec.intent,
    prompt: spec.prompt,
    // The AI routes carry no connection id and web has no authenticated
    // actor yet — the same `actor: null` the query path records.
    connectionId: null,
    actor: null,
    startTimeMs: nowMs(),
    provider: provider.getId(),
    model: provider.getModel(),
  };

  let response: AiResponse;
  try {
    response = await spec.invoke(provider);
  } catch (err) {
    // Record exactly when we wrap. A non-AiError is a bug in our own
    // code, not an AI outcome, and the record's three categories
    // (network / provider / configuration) have no honest slot for it —
    // filing it under `provider` would blame Anthropic for our crash.
    if (err instanceof AiError) {
      await safeRecord(() =>
        history.recordAiError(
          ctx,
          { response: "", tokensIn: null, tokensOut: null, stopReason: null },
          err,
        ),
      );
      throw new AiUpstreamError(err.message, { cause: err });
    }
    throw err;
  }

  await safeRecord(() => history.recordAiSuccess(ctx, outcomeOf(response)));
  return response;
}

function outcomeOf(response: AiResponse) {
  return {
    response: response.text,
    tokensIn: response.tokensIn,
    tokensOut: response.tokensOut,
    stopReason: response.stopReason,
    servedModel: response.model,
  };
}

async function safeRecord(write: () => Promise<void>): Promise<void> {
  try {
    await write();
  } catch {
    // Swallowed deliberately — see module comment.
  }
}
