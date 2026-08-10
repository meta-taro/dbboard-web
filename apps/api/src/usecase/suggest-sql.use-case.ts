import { streamSuggestSql } from "../domain/ai/ai-stream";
import type { AiProviderRegistry } from "../domain/ai/ai-provider-registry.port";
import type { AiResponse, StreamEvent, SuggestRequest } from "../domain/ai/ai-provider.port";
import { runRecordedAiCall, runRecordedAiStream } from "./record-ai-call";
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

  // See explain-sql.use-case.ts for why this resolves synchronously
  // rather than being an async generator.
  stream(command: SuggestCommand): AsyncIterable<StreamEvent> {
    const { provider: providerId, ...request } = command;
    const provider = this.registry.resolve(providerId);
    return runRecordedAiStream(
      provider,
      this.history,
      {
        intent: "suggest_sql",
        prompt: request.prompt,
        invoke: (resolved, options) => streamSuggestSql(resolved, request, options),
      },
      this.nowMs,
    );
  }
}
