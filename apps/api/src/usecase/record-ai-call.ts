import { AiError, AiUpstreamError } from "../domain/ai/ai-error";
import type {
  AiProvider,
  AiResponse,
  AiStreamOptions,
  StreamEvent,
} from "../domain/ai/ai-provider.port";
import type { AiRecordContext, RecordHistory } from "./record-history.use-case";

// The shared body of every AI use case: time the call, translate
// failures to the wire taxonomy, and write a history v:2 `kind: "ai"`
// record. Resolving *which* provider answers happens before this, in
// the registry — by the time we are here there is one, and the disabled
// deployment never reaches this function. ExplainSql and SuggestSql differ only in
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
  provider: AiProvider,
  history: RecordHistory,
  spec: AiCallSpec,
  nowMs: () => number,
): Promise<AiResponse> {
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

export interface AiStreamSpec {
  intent: AiRecordContext["intent"];
  prompt: string;
  invoke: (provider: AiProvider, options: AiStreamOptions) => AsyncIterable<StreamEvent>;
}

// How a stream ended, in the recorder's own vocabulary. It starts at
// `cancelled` and is only moved off it by something that proves
// otherwise, because the one terminus with no event of its own is the
// consumer walking away: a `break` in the caller's loop calls this
// generator's `.return()`, which skips straight past the post-loop
// assignment into `finally`. Defaulting the other way would mean a
// cancel writes nothing, which is the one outcome we most need logged
// (DoD 4) — the user stopped it, but the tokens were still spent.
type Terminus = "cancelled" | "ok" | "error" | "crashed";

// The streaming sibling of runRecordedAiCall: same context, same
// best-effort recording, same rule that only an AiError is an AI outcome
// — but the record is assembled from events as they pass through rather
// than read off a returned response, and there are three ways to end
// instead of two.
export async function* runRecordedAiStream(
  provider: AiProvider,
  history: RecordHistory,
  spec: AiStreamSpec,
  nowMs: () => number,
): AsyncGenerator<StreamEvent> {
  const ctx: AiRecordContext = {
    intent: spec.intent,
    prompt: spec.prompt,
    connectionId: null,
    actor: null,
    startTimeMs: nowMs(),
    provider: provider.getId(),
    model: provider.getModel(),
  };

  // Owned here rather than by the caller so cancellation cannot be
  // forgotten: whatever ends this generator runs the `finally` below,
  // and the abort reaches the transport from there.
  const abort = new AbortController();
  let terminus: Terminus = "cancelled";
  let failure: AiError | undefined;
  let text = "";
  let tokensIn: number | null = null;
  let tokensOut: number | null = null;
  let stopReason: string | null = null;
  let servedModel: string | undefined;
  let sawStop = false;

  try {
    for await (const event of spec.invoke(provider, { signal: abort.signal })) {
      switch (event.type) {
        case "message_start":
          tokensIn = event.tokensIn ?? tokensIn;
          servedModel = event.model ?? servedModel;
          break;
        case "text_delta":
          text += event.text;
          break;
        case "usage":
          // Replace, never add (ADR-0026 Decision 7) — these are running
          // totals. A null means this event reported nothing, so the
          // figure we already have still stands.
          tokensIn = event.tokensIn ?? tokensIn;
          tokensOut = event.tokensOut ?? tokensOut;
          break;
        case "message_stop":
          stopReason = event.stopReason;
          // A consumer is free to stop reading here; the call still
          // completed and was still billed in full, so this flag keeps
          // the default terminus from calling it a cancel.
          sawStop = true;
          break;
        default:
          break;
      }
      yield event;
    }
    terminus = "ok";
  } catch (err) {
    if (err instanceof AiError) {
      terminus = "error";
      failure = err;
      throw new AiUpstreamError(err.message, { cause: err });
    }
    terminus = "crashed";
    throw err;
  } finally {
    abort.abort();
    const outcome = { response: text, tokensIn, tokensOut, stopReason, servedModel };
    if (terminus === "error" && failure) {
      await safeRecord(() => history.recordAiError(ctx, outcome, failure));
    } else if (terminus === "ok" || sawStop) {
      await safeRecord(() => history.recordAiSuccess(ctx, outcome));
    } else if (terminus === "cancelled") {
      await safeRecord(() =>
        // The v:2 vocabulary has no `cancelled` stop reason and needs
        // none — the escape hatch already carries values outside the
        // canonical set, so this costs no schema change and stays
        // byte-compatible with desktop's records.
        history.recordAiCancelled(ctx, { ...outcome, stopReason: "other:cancelled" }),
      );
    }
    // `crashed` writes nothing: a bug in our own code is not an AI
    // outcome, and the three recorded categories have no honest slot
    // for it. Same reasoning as the atomic path above.
  }
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
