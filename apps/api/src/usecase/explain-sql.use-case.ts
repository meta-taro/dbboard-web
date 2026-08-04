import type { AiProvider, AiResponse, ExplainRequest } from "../domain/ai/ai-provider.port";
import { runRecordedAiCall } from "./record-ai-call";
import type { RecordHistory } from "./record-history.use-case";

// ExplainSql is the use-case seam between the controller and the AI
// provider port. It owns three concerns the controller should not:
//   1. The deployment may have no provider configured — translate that
//      into a wire-mapped AiDisabledError (→ 404) so the UI can hide
//      the AI panel instead of treating the absence as an error.
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

export class ExplainSql {
  constructor(
    private readonly provider: AiProvider | undefined,
    private readonly history: RecordHistory,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async execute(request: ExplainRequest): Promise<AiResponse> {
    return runRecordedAiCall(
      this.provider,
      this.history,
      {
        intent: "explain",
        // For an explain, the SQL under discussion *is* the prompt.
        prompt: request.sql,
        invoke: (provider) => provider.explain(request),
      },
      this.nowMs,
    );
  }
}
