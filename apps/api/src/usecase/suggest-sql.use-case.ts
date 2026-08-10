import type { AiProviderRegistry } from "../domain/ai/ai-provider-registry.port";
import type { AiResponse, SuggestRequest } from "../domain/ai/ai-provider.port";
import { runRecordedAiCall } from "./record-ai-call";
import type { RecordHistory } from "./record-history.use-case";

// Twin of ExplainSql for natural-language → SQL suggestion. Same
// resolution / upstream / bubble / recording policy — see
// explain-sql.use-case.ts for the rationale.

export type SuggestCommand = SuggestRequest & { provider?: string };

export class SuggestSql {
  constructor(
    private readonly registry: AiProviderRegistry,
    private readonly history: RecordHistory,
    private readonly nowMs: () => number = () => Date.now(),
  ) {}

  async execute(command: SuggestCommand): Promise<AiResponse> {
    const { provider: providerId, ...request } = command;
    const provider = this.registry.resolve(providerId);
    return runRecordedAiCall(
      provider,
      this.history,
      {
        intent: "suggest_sql",
        prompt: request.prompt,
        invoke: (resolved) => resolved.suggestSql(request),
      },
      this.nowMs,
    );
  }
}
