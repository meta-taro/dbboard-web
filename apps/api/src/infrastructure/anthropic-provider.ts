import { AiError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiCapabilities,
  type AiProvider,
  type AiResponse,
  type ExplainRequest,
  type SuggestRequest,
} from "../domain/ai/ai-provider.port";

// The narrow `Anthropic` slice we depend on. Defining it here (instead
// of pulling `Anthropic#messages` into the adapter signature) keeps
// unit tests stub-friendly — they construct an object with just
// `messages.create`, no real HTTP involved. The real SDK client
// satisfies this structurally; the wiring layer (app.module.ts) bridges
// the two with a single `as unknown as` because the SDK's overload set
// is wider than the non-streaming slice we use.
export interface AnthropicMessageRequest {
  model: string;
  max_tokens: number;
  system?: string;
  messages: { role: "user"; content: string }[];
}

export interface AnthropicMessageResponse {
  content: { type: string; text?: string }[];
  model: string;
}

export interface AnthropicClient {
  messages: {
    create(body: AnthropicMessageRequest): Promise<AnthropicMessageResponse>;
  };
}

// Single-turn response cap. Generous enough for a SQL explanation or a
// query suggestion, small enough that a misconfigured prompt cannot
// burn through a budget. Stage 2 may surface this as a per-request
// option once the UI demands streaming long-form output.
const MAX_OUTPUT_TOKENS = 1024;

const EXPLAIN_SYSTEM = "You are a database expert. Explain SQL queries concisely in plain English.";

const SUGGEST_SYSTEM =
  "You are a database expert. Translate the user's natural-language request into a single SQL query. Return only the SQL — no prose, no fenced code block, no commentary.";

function buildExplainPrompt({ sql, dialect }: ExplainRequest): string {
  const dialectLine = dialect ? `Dialect: ${dialect}\n\n` : "";
  return `${dialectLine}Explain the following SQL query:\n\n${sql}`;
}

function buildSuggestPrompt({ prompt, dialect }: SuggestRequest): string {
  const dialectLine = dialect ? `Dialect: ${dialect}\n\n` : "";
  return `${dialectLine}Request: ${prompt}`;
}

function extractText(response: AnthropicMessageResponse): string {
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  throw new AiError("Anthropic response contained no text block");
}

export class AnthropicProvider implements AiProvider {
  constructor(
    private readonly client: AnthropicClient,
    private readonly model: string,
  ) {}

  getId(): string {
    return "anthropic";
  }

  getCapabilities(): AiCapabilities {
    return NO_AI_CAPABILITIES;
  }

  async explain(request: ExplainRequest): Promise<AiResponse> {
    return this.complete(EXPLAIN_SYSTEM, buildExplainPrompt(request));
  }

  async suggestSql(request: SuggestRequest): Promise<AiResponse> {
    return this.complete(SUGGEST_SYSTEM, buildSuggestPrompt(request));
  }

  private async complete(system: string, userContent: string): Promise<AiResponse> {
    let response: AnthropicMessageResponse;
    try {
      response = await this.client.messages.create({
        model: this.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages: [{ role: "user", content: userContent }],
      });
    } catch (cause: unknown) {
      throw new AiError("Anthropic provider request failed", { cause });
    }
    return { text: extractText(response), model: response.model };
  }
}
