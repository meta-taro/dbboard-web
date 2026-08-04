import type { AiProvider, AiResponse, SuggestRequest } from "../domain/ai/ai-provider.port";
import { runRecordedAiCall } from "./record-ai-call";
import type { RecordHistory } from "./record-history.use-case";

// Twin of ExplainSql for natural-language → SQL suggestion. Same
// disabled / upstream / bubble / recording policy — see
// explain-sql.use-case.ts for the rationale.

export class SuggestSql {
  constructor(
    private readonly provider: AiProvider | undefined,
    private readonly history: RecordHistory,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async execute(request: SuggestRequest): Promise<AiResponse> {
    return runRecordedAiCall(
      this.provider,
      this.history,
      {
        intent: "suggest_sql",
        prompt: request.prompt,
        invoke: (provider) => provider.suggestSql(request),
      },
      this.nowMs,
    );
  }
}
