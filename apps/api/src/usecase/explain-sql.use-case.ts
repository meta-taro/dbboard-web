import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import type { AiProvider, AiResponse, ExplainRequest } from "../domain/ai/ai-provider.port";

// ExplainSql is the use-case seam between the controller and the AI
// provider port. It owns two concerns the controller should not:
//   1. The deployment may have no provider configured — translate that
//      into a wire-mapped AiDisabledError (→ 404) so the UI can hide
//      the AI panel instead of treating the absence as an error.
//   2. The adapter throws its own AiError on upstream failure — wrap
//      it in AiUpstreamError (→ 502) so the wire status comes from
//      one place. Cause is preserved for diagnostics.
//
// Non-AiError throws (TypeError, etc.) bubble untouched — those are
// programming bugs and surface as 500 from Nest's default filter.

export class ExplainSql {
  constructor(private readonly provider: AiProvider | undefined) {}

  async execute(request: ExplainRequest): Promise<AiResponse> {
    if (this.provider === undefined) {
      throw new AiDisabledError("AI provider is not configured");
    }
    try {
      return await this.provider.explain(request);
    } catch (err) {
      if (err instanceof AiError) {
        throw new AiUpstreamError(err.message, { cause: err });
      }
      throw err;
    }
  }
}
