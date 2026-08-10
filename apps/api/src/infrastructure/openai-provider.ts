import { AiError } from "../domain/ai/ai-error";
import {
  NO_AI_CAPABILITIES,
  type AiCapabilities,
  type AiProvider,
  type AiResponse,
  type AiStreamOptions,
  type ExplainRequest,
  type StreamEvent,
  type SuggestRequest,
} from "../domain/ai/ai-provider.port";
import {
  EXPLAIN_SYSTEM,
  SUGGEST_SYSTEM,
  buildExplainPrompt,
  buildSuggestPrompt,
} from "./ai-prompts";
import { categoriseStatus, normaliseStopReason, tokenCount } from "./ai-response-mapping";
import { FetchOpenAiTransport } from "./openai-transport";

// OpenAI chat completions, mirroring desktop `crates/dbboard-openai` at
// `b98f7a6` (ADR-0052). Three things differ from the Anthropic adapter,
// and only three:
//
// - the system prompt travels as a `role: "system"` entry at the head of
//   `messages`, not as a top-level field;
// - usage is `prompt_tokens` / `completion_tokens`;
// - the terminus is `finish_reason` in OpenAI's own vocabulary, so it is
//   translated into the history v:2 one rather than passed through.
//
// The auth header is the fourth axis and lives in the transport. Prompts
// and reporting are shared (`ai-prompts.ts`, `ai-response-mapping.ts`),
// which is what keeps the two adapters diffable.

const PROVIDER_ID = "openai";

// Cap on response text surfaced in an error, so a hostile or malformed
// body cannot put an unbounded string in an error message. Desktop's
// `MAX_ERROR_DETAIL`.
const MAX_ERROR_DETAIL = 2048;

const DONE_SENTINEL = "[DONE]";

export interface OpenAiChatMessage {
  role: "system" | "user";
  content: string;
}

export interface OpenAiChatRequest {
  model: string;
  messages: OpenAiChatMessage[];
  stream?: boolean;
  stream_options?: { include_usage: true };
}

/** What the transport hands back: an HTTP status and the response text. */
export interface OpenAiHttpResponse {
  status: number;
  body: string;
}

/**
 * The outcome of opening a stream. A refusal is data rather than a throw
 * because it is an ordinary HTTP status that arrived before any frame,
 * and the provider categorises it with the same rule it uses on the
 * atomic path.
 */
export type OpenAiStreamOpen =
  | { ok: true; frames: AsyncIterable<string> }
  | { ok: false; status: number; body: string };

/**
 * The HTTP seam, narrow enough for a test to implement in three lines —
 * the shape `d1-adapter.ts` and `anthropic-provider.ts` already use. The
 * adapter owns parsing, envelope checking and error classification; only
 * the socket sits behind the interface. `stream` yields each SSE `data:`
 * payload verbatim, `[DONE]` included, because deciding what a payload
 * means is the adapter's job too.
 */
export interface OpenAiTransport {
  post(body: OpenAiChatRequest): Promise<OpenAiHttpResponse>;
  stream(body: OpenAiChatRequest, options?: { signal?: AbortSignal }): Promise<OpenAiStreamOpen>;
}

interface OpenAiChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null; role?: string };
  finish_reason?: string | null;
}

interface OpenAiCompletion {
  model?: string;
  choices?: OpenAiChoice[];
  usage?: { prompt_tokens?: number | null; completion_tokens?: number | null } | null;
  error?: { type?: string; message?: string };
}

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

export class OpenAiProvider implements AiProvider {
  constructor(
    private readonly transport: OpenAiTransport,
    private readonly model: string,
  ) {}

  getId(): string {
    return PROVIDER_ID;
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): AiCapabilities {
    // Same promise the Anthropic adapter makes (ADR-0026 Decision 8):
    // `streaming: true` obliges the overrides below to be real.
    return { ...NO_AI_CAPABILITIES, streaming: true };
  }

  async explain(request: ExplainRequest): Promise<AiResponse> {
    return this.complete(EXPLAIN_SYSTEM, buildExplainPrompt(request));
  }

  async suggestSql(request: SuggestRequest): Promise<AiResponse> {
    return this.complete(SUGGEST_SYSTEM, buildSuggestPrompt(request));
  }

  streamExplain(request: ExplainRequest, options?: AiStreamOptions): AsyncIterable<StreamEvent> {
    return this.completeStream(EXPLAIN_SYSTEM, buildExplainPrompt(request), options);
  }

  streamSuggestSql(request: SuggestRequest, options?: AiStreamOptions): AsyncIterable<StreamEvent> {
    return this.completeStream(SUGGEST_SYSTEM, buildSuggestPrompt(request), options);
  }

  private async complete(system: string, userContent: string): Promise<AiResponse> {
    let response: OpenAiHttpResponse;
    try {
      response = await this.transport.post(this.body(system, userContent));
    } catch (cause: unknown) {
      // The transport hands statuses back as data, so a throw from it
      // means the request never reached a server.
      throw new AiError("OpenAI provider request failed", { cause, category: "network" });
    }

    const completion = decodeCompletion(response);
    return {
      text: extractText(completion),
      // Desktop stamps the configured model because its response type
      // does not carry one; web's `AiResponse.model` is what the history
      // record and the panel show, so the served id is preferred when
      // there is one.
      model: nonEmpty(completion.model) ?? this.model,
      tokensIn: tokenCount(completion.usage?.prompt_tokens),
      tokensOut: tokenCount(completion.usage?.completion_tokens),
      stopReason: mapFinishReason(completion.choices?.[0]?.finish_reason),
    };
  }

  // OpenAI's wire is data-only frames terminated by `[DONE]`, with no
  // event names and no opening frame carrying the input count — that
  // arrives last, on a choices-empty `usage` frame, which is why
  // `stream_options.include_usage` is asked for. Desktop omits
  // `MessageStart` here for want of a token count; web emits one anyway,
  // because its variant also carries the served model (the port
  // documents that deviation) and the panel shows it.
  private async *completeStream(
    system: string,
    userContent: string,
    options?: AiStreamOptions,
  ): AsyncGenerator<StreamEvent> {
    let opened: OpenAiStreamOpen;
    try {
      opened = await this.transport.stream(
        {
          ...this.body(system, userContent),
          stream: true,
          stream_options: { include_usage: true },
        },
        { signal: options?.signal },
      );
    } catch (cause: unknown) {
      if (cause instanceof AiError) throw cause;
      throw new AiError("OpenAI provider stream failed", { cause, category: "network" });
    }
    if (!opened.ok) throw upstreamError(opened.status, opened.body);

    let started = false;
    let stopReason: string | null = null;
    try {
      for await (const frame of opened.frames) {
        const data = frame.trim();
        if (data === "") continue;
        // Terminated and merely ended are the same terminus: both mean no
        // more text is coming, and only one of them is guaranteed to
        // arrive when a connection drops.
        if (data === DONE_SENTINEL) break;

        const chunk = parseChunk(data);
        if (chunk.error) {
          throw new AiError(errorDetail(chunk), { category: "provider" });
        }
        if (!started) {
          started = true;
          yield {
            type: "message_start",
            tokensIn: tokenCount(chunk.usage?.prompt_tokens),
            model: nonEmpty(chunk.model) ?? null,
          };
        }
        for (const choice of chunk.choices ?? []) {
          if (typeof choice.finish_reason === "string" && choice.finish_reason !== "") {
            // Carried forward rather than emitted where it appears: it
            // describes the terminus, not this frame.
            stopReason = mapFinishReason(choice.finish_reason);
          }
          const text = choice.delta?.content;
          // The opening frame carries `role` and an empty string; there is
          // no text in it to show.
          if (typeof text === "string" && text !== "") {
            yield { type: "text_delta", text };
          }
        }
        if (chunk.usage) {
          yield {
            type: "usage",
            tokensIn: tokenCount(chunk.usage.prompt_tokens),
            tokensOut: tokenCount(chunk.usage.completion_tokens),
          };
        }
      }
    } catch (cause: unknown) {
      if (cause instanceof AiError) throw cause;
      throw new AiError("OpenAI provider stream failed", { cause, category: "network" });
    }

    // A stream that carried nothing still opened and closed, so it still
    // gets both bookends — a consumer should not have to special-case it.
    if (!started) {
      yield { type: "message_start", tokensIn: null, model: null };
    }
    yield { type: "message_stop", stopReason };
  }

  private body(system: string, userContent: string): OpenAiChatRequest {
    return {
      model: this.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userContent },
      ],
      // No output cap on purpose. gpt-4o takes `max_tokens`, the o-series
      // and gpt-5 reject it in favour of `max_completion_tokens`, so
      // sending neither is what keeps an arbitrary model id working —
      // and the system prompts already ask for a short answer.
    };
  }
}

export function createOpenAiProvider(options: OpenAiProviderOptions): OpenAiProvider {
  const apiKey = options.apiKey.trim();
  const model = options.model.trim();
  // Fail here rather than sending `Bearer ` and reading back a 401 that
  // looks like a wrong credential instead of a missing one. Desktop's
  // `with_config` rejects both the same way.
  if (!apiKey) {
    throw new AiError("openai provider requires an api key", { category: "configuration" });
  }
  if (!model) {
    throw new AiError("openai provider requires a model", { category: "configuration" });
  }
  return new OpenAiProvider(new FetchOpenAiTransport({ apiKey, baseUrl: options.baseUrl }), model);
}

// OpenAI's terminal reasons, translated into the history v:2 vocabulary.
// A Map rather than an object literal because `finish_reason` is
// attacker-adjacent input and `{}["constructor"]` is not undefined.
const FINISH_REASONS = new Map<string, string>([
  // Covers both a natural end and a stop sequence being hit; OpenAI does
  // not distinguish them, so it cannot become `stop_sequence`.
  ["stop", "end_turn"],
  ["length", "max_tokens"],
  ["tool_calls", "tool_use"],
  ["function_call", "tool_use"],
  ["content_filter", "refusal"],
]);

function mapFinishReason(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") return null;
  // An unmapped value still goes through the shared guard, which routes
  // it to `other:<raw>` rather than dropping it.
  return normaliseStopReason(FINISH_REASONS.get(raw) ?? raw);
}

function decodeCompletion(response: OpenAiHttpResponse): OpenAiCompletion {
  if (response.status < 200 || response.status >= 300) {
    throw upstreamError(response.status, response.body);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(response.body);
  } catch (cause: unknown) {
    // Transport succeeded; the body was unusable. That is the provider's
    // output, not the network.
    throw new AiError(`OpenAI response was not JSON: ${truncate(response.body)}`, {
      cause,
      category: "provider",
    });
  }
  return (parsed ?? {}) as OpenAiCompletion;
}

function extractText(completion: OpenAiCompletion): string {
  let text = "";
  for (const choice of completion.choices ?? []) {
    if (typeof choice.message?.content === "string") {
      text += choice.message.content;
    }
  }
  if (text === "") {
    throw new AiError("OpenAI returned no text content in response", { category: "provider" });
  }
  return text;
}

function upstreamError(status: number, body: string): AiError {
  return new AiError(`OpenAI API error (status ${status}): ${bodyErrorDetail(body)}`, {
    category: categoriseStatus(status),
  });
}

// Prefer OpenAI's documented `{ "error": { type, message } }` envelope,
// fall back to the raw text — a gateway in front of the API answers in
// HTML, and that page is the only clue the operator has.
function bodyErrorDetail(body: string): string {
  try {
    const parsed = JSON.parse(body) as OpenAiCompletion;
    if (parsed?.error) return errorDetail(parsed);
  } catch {
    // Not JSON. The raw text below is the better answer anyway.
  }
  return truncate(body);
}

function errorDetail(payload: OpenAiCompletion): string {
  const message = payload.error?.message;
  if (typeof message !== "string" || message === "") return truncate(JSON.stringify(payload.error));
  return truncate(`[${payload.error?.type ?? "error"}] ${message}`);
}

function parseChunk(data: string): OpenAiCompletion {
  try {
    return JSON.parse(data) as OpenAiCompletion;
  } catch (cause: unknown) {
    throw new AiError(`OpenAI streaming: malformed chunk payload: ${truncate(data)}`, {
      cause,
      category: "provider",
    });
  }
}

function truncate(text: string): string {
  if (text.length <= MAX_ERROR_DETAIL) return text;
  let cut = MAX_ERROR_DETAIL;
  // Never split a surrogate pair: half of one renders as a replacement
  // character and makes the excerpt harder to read than it needs to be.
  const last = text.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return `${text.slice(0, cut)}…`;
}

function nonEmpty(value: string | null | undefined): string | null {
  return typeof value === "string" && value !== "" ? value : null;
}
