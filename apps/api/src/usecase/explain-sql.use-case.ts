import { streamExplain } from "../domain/ai/ai-stream";
import type { AiProviderRegistry } from "../domain/ai/ai-provider-registry.port";
import type { AiResponse, ExplainRequest, StreamEvent } from "../domain/ai/ai-provider.port";
import { runRecordedAiCall, runRecordedAiStream } from "./record-ai-call";
import type { RecordHistory } from "./record-history.use-case";

// ExplainSql is the use-case seam between the controller and the AI
// provider port. It owns three concerns the controller should not:
//   1. Which provider answers. The registry decides, and its two
//      refusals reach the wire differently: nothing configured is a
//      404 (→ the UI hides the AI panel rather than showing an error),
//      a name this deployment does not have is a 422.
//   2. The adapter throws its own AiError on upstream failure — wrap
//      it in AiUpstreamError (→ 502) so the wire status comes from
//      one place. Cause is preserved for diagnostics.
//   3. Write the history v:2 `kind: "ai"` record. This layer owns the
//      timing boundary and the AiError taxonomy, so it is the only
//      place that can record both honestly.
//
// Non-AiError throws (TypeError, etc.) bubble untouched and unrecorded
// — those are programming bugs, not AI outcomes. See record-ai-call.ts
// for the shared body.

// `provider` is addressing, not content: it says who answers, and it is
// stripped before the request reaches whoever does. Widening the port's
// request type here rather than in the port keeps the port describing
// what a provider is asked, which never includes its own name.
export type ExplainCommand = ExplainRequest & { provider?: string };

export class ExplainSql {
  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly history: RecordHistory,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async execute(command: ExplainCommand): Promise<AiResponse> {
    const { provider: providerId, ...request } = command;
    // Resolution happens before the recorded call so that a refusal
    // writes nothing: no provider was reached, so there is no provider
    // or model to name, and the record schema requires both.
    const provider = this.registry.resolve(providerId);
    return runRecordedAiCall(
      provider,
      this.history,
      {
        intent: "explain",
        // For an explain, the SQL under discussion *is* the prompt.
        prompt: request.sql,
        invoke: (resolved) => resolved.explain(request),
      },
      this.nowMs,
    );
  }

  // The streaming twin. Deliberately *not* an async method: an async
  // function defers its whole body to the microtask queue, and an async
  // generator defers it until the first `next()`, either of which would
  // push the registry's refusal past the point where the controller has
  // committed to a 200. Resolving here, synchronously, keeps
  // AiDisabledError (404) and AiUnknownProviderError (422) on the same
  // wire path they take for the atomic call.
  //
  // The upstream request still does not start until the returned
  // iterable is read — runRecordedAiStream is a generator — so a caller
  // that resolves and then abandons the stream spends nothing.
  stream(command: ExplainCommand): AsyncIterable<StreamEvent> {
    const { provider: providerId, ...request } = command;
    const provider = this.registry.resolve(providerId);
    return runRecordedAiStream(
      provider,
      this.history,
      {
        intent: "explain",
        prompt: request.sql,
        // Via the port's free function, not `resolved.streamExplain`
        // directly: a provider without a real stream gets the one-chunk
        // delegate, so this route works the same whether or not the
        // configured provider advertises `streaming`.
        invoke: (resolved, options) => streamExplain(resolved, request, options),
      },
      this.nowMs,
    );
  }
}
