import { AiDisabledError, AiError, AiUpstreamError } from "../domain/ai/ai-error";
import type { AiProvider, AiResponse, SuggestRequest } from "../domain/ai/ai-provider.port";

// Twin of ExplainSql for natural-language → SQL suggestion. Same
// disabled / upstream / bubble policy — see explain-sql.use-case.ts
// for the rationale.

export class SuggestSql {
  constructor(private readonly provider: AiProvider | undefined) {}

  async execute(request: SuggestRequest): Promise<AiResponse> {
    if (this.provider === undefined) {
      throw new AiDisabledError("AI provider is not configured");
    }
    try {
      return await this.provider.suggestSql(request);
    } catch (err) {
      if (err instanceof AiError) {
        throw new AiUpstreamError(err.message, { cause: err });
      }
      throw err;
    }
  }
}
