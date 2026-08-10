import { AiError, type AiErrorCategory } from "../domain/ai/ai-error";
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
import type { TableInfo } from "../domain/values/table-info";

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
  // Both optional: the slice must keep accepting the older stub shape,
  // and a provider that reports neither is a legitimate case the
  // history record represents as null rather than zero.
  stop_reason?: string | null;
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
}

// One raw server-sent event, typed loosely on purpose. Anthropic adds
// event and delta kinds over time, and an exhaustive union here would
// turn every such addition into a crash instead of the shrug the
// normalising layer below gives it.
export interface AnthropicStreamEvent {
  type: string;
  message?: {
    model?: string;
    usage?: { input_tokens?: number | null; output_tokens?: number | null };
  };
  // `text_delta` is the only kind that becomes user-visible text; the
  // rest are read for their absence.
  delta?: {
    type?: string;
    text?: string;
    stop_reason?: string | null;
    [key: string]: unknown;
  };
  // On `message_delta` these counts are cumulative, not incremental.
  usage?: { input_tokens?: number | null; output_tokens?: number | null };
  error?: { type?: string; message?: string };
  [key: string]: unknown;
}

export interface AnthropicClient {
  messages: {
    create(body: AnthropicMessageRequest): Promise<AnthropicMessageResponse>;
    // Required rather than optional: `getCapabilities().streaming` is a
    // promise the adapter makes on its client's behalf (ADR-0026
    // Decision 8), and it cannot keep that promise with a client that
    // has no stream. The wiring layer bridges the SDK's
    // `create({stream: true})` onto this name.
    stream(
      body: AnthropicMessageRequest,
      options?: { signal?: AbortSignal },
    ): AsyncIterable<AnthropicStreamEvent>;
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

// Desktop's `qualify` (crates/dbboard-anthropic): a schema-qualified name
// when the table has one, the bare name when it does not.
function qualify(table: TableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}

// Mirrors desktop's `build_suggest_request` ordering — tables, then
// dialect, then the request — with one case desktop cannot have. Desktop
// always passes a (possibly empty) list, so it always emits the block;
// web's `schema` is optional, and when it is absent the block is omitted
// entirely so a caller that cannot introspect gets the prompt it got
// before ADR-0028 Decision 8 landed, byte for byte.
function buildSuggestPrompt({ prompt, dialect, schema }: SuggestRequest): string {
  const segments: string[] = [];
  if (schema) {
    // An empty list is stated, not skipped: "there are none" stops the
    // model inventing a plausible table, which silence does not.
    const body =
      schema.length === 0
        ? "(no tables introspected)"
        : schema.map((table) => `- ${qualify(table)}`).join("\n");
    segments.push(`Tables:\n${body}`);
  }
  if (dialect) {
    segments.push(`Dialect: ${dialect}`);
  }
  segments.push(`Request: ${prompt}`);
  return segments.join("\n\n");
}

function extractText(response: AnthropicMessageResponse): string {
  for (const block of response.content) {
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  // Transport succeeded; the body was unusable. That is the provider's
  // output, not the network.
  throw new AiError("Anthropic response contained no text block", { category: "provider" });
}

// The history v:2 vocabulary (desktop brief 0008 § stop_reason).
// Anything outside it goes through the `other:<text>` escape hatch so
// the raw value stays legible instead of collapsing to null — Anthropic
// adds terminal reasons over time and this field is informational.
const CANONICAL_STOP_REASONS = new Set([
  "end_turn",
  "max_tokens",
  "stop_sequence",
  "tool_use",
  "refusal",
]);

function normaliseStopReason(raw: string | null | undefined): string | null {
  if (typeof raw !== "string" || raw === "") {
    return null;
  }
  return CANONICAL_STOP_REASONS.has(raw) ? raw : `other:${raw}`;
}

// Null means "not reported". Never substitute a zero: in the history
// log a fabricated count is indistinguishable from a measured one.
function tokenCount(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The SDK's typed errors carry an HTTP `status`; a transport failure
// carries none. 401/403 is the deployment's key being wrong or
// unentitled — filing that under `provider` would point an operator at
// Anthropic's status page for a problem in their own environment.
function categoriseUpstream(cause: unknown): AiErrorCategory {
  const status =
    typeof cause === "object" && cause !== null && "status" in cause
      ? (cause as { status: unknown }).status
      : undefined;
  if (typeof status !== "number") {
    return "network";
  }
  return status === 401 || status === 403 ? "configuration" : "provider";
}

export class AnthropicProvider implements AiProvider {
  constructor(
    private readonly client: AnthropicClient,
    private readonly model: string,
  ) {}

  getId(): string {
    return "anthropic";
  }

  getModel(): string {
    return this.model;
  }

  getCapabilities(): AiCapabilities {
    // `streaming: true` obliges the overrides below to exist and to be
    // real (ADR-0026 Decision 8) — it is not a hint that streaming might
    // be nice here. `functionCalling` stays false: nothing implements it.
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

  // Anthropic's wire order is message_start, then blocks, then
  // message_delta, then message_stop; stop_reason arrives on
  // message_delta but describes the terminus, so it is carried forward
  // rather than emitted where it appears.
  //
  // Every failure leaves by the same door — a thrown AiError — whether
  // it happened opening the stream, mid-iteration, or as an in-band
  // `error` event. The port's `error` variant exists for the wire
  // boundary, where a 200 has already gone out and a thrown error has
  // nowhere to go; a provider is not that boundary.
  private async *completeStream(
    system: string,
    userContent: string,
    options?: AiStreamOptions,
  ): AsyncGenerator<StreamEvent> {
    let stopReason: string | null | undefined;
    try {
      const events = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          system,
          messages: [{ role: "user", content: userContent }],
        },
        { signal: options?.signal },
      );

      for await (const event of events) {
        switch (event.type) {
          case "message_start":
            yield {
              type: "message_start",
              tokensIn: tokenCount(event.message?.usage?.input_tokens),
              model: event.message?.model ?? null,
            };
            break;
          case "content_block_delta":
            // Only text becomes text. `input_json_delta`,
            // `thinking_delta` and `signature_delta` are dropped here
            // (ADR-0026 Decision 3) so no consumer has to know they exist.
            if (event.delta?.type === "text_delta" && typeof event.delta.text === "string") {
              yield { type: "text_delta", text: event.delta.text };
            }
            break;
          case "message_delta":
            if (event.delta && "stop_reason" in event.delta) {
              stopReason = event.delta.stop_reason;
            }
            if (event.usage) {
              yield {
                type: "usage",
                tokensIn: tokenCount(event.usage.input_tokens),
                tokensOut: tokenCount(event.usage.output_tokens),
              };
            }
            break;
          case "message_stop":
            yield { type: "message_stop", stopReason: normaliseStopReason(stopReason) };
            break;
          case "error":
            throw new AiError(event.error?.message ?? "Anthropic stream reported an error", {
              category: "provider",
            });
          default:
            // `ping`, the block boundaries, and whatever Anthropic adds
            // next. Silence is the forward-compatible answer.
            break;
        }
      }
    } catch (cause: unknown) {
      if (cause instanceof AiError) throw cause;
      throw new AiError("Anthropic provider stream failed", {
        cause,
        category: categoriseUpstream(cause),
      });
    }
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
      throw new AiError("Anthropic provider request failed", {
        cause,
        category: categoriseUpstream(cause),
      });
    }
    return {
      text: extractText(response),
      model: response.model,
      tokensIn: tokenCount(response.usage?.input_tokens),
      tokensOut: tokenCount(response.usage?.output_tokens),
      stopReason: normaliseStopReason(response.stop_reason),
    };
  }
}
