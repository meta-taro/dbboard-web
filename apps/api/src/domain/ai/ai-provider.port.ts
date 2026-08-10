// AI provider port — TypeScript-flavored mirror of the desktop
// `AiProvider` trait (desktop ADR-0023, `crates/dbboard-ai`). Same
// conceptual surface (`id` / `capabilities` / `explain` / `suggestSql`)
// so a maintainer running both repos recognises the shape; the
// implementation is independent because the wire contract is silent on
// AI by design (ADR-0023 Decision 3 — in-process wiring only).
//
// Stage 1 ships the port + one Anthropic adapter behind a `useFactory`
// gate. Future consumers (a web-only `POST /ai/*` route, a Nuxt
// composable) inject `AI_PROVIDER` with `@Optional()` because the
// factory returns `undefined` when no API key is configured.

import type { AiErrorCategory } from "./ai-error";
import type { TableInfo } from "../values/table-info";

export interface AiCapabilities {
  // Flat-bool, all-false default — mirrors desktop's `AiCapabilities`.
  // `streaming` is a contract, not a hint (desktop ADR-0026 Decision 8):
  // `true` means this provider overrides the streaming methods below
  // with a real token-granularity implementation, `false` means it gets
  // the delegate in ai-stream.ts and its answer arrives as one chunk.
  // Function-calling is still off everywhere — no adapter implements it.
  streaming: boolean;
  functionCalling: boolean;
}

export const NO_AI_CAPABILITIES: AiCapabilities = {
  streaming: false,
  functionCalling: false,
};

export interface ExplainRequest {
  sql: string;
  // Free-form dialect tag (e.g. "postgres", "sqlite") to bias the
  // explanation. The adapter passes it verbatim into the prompt.
  dialect?: string;
}

export interface SuggestRequest {
  prompt: string;
  dialect?: string;
  // The tables the caller introspected, rendered ahead of the request so
  // the model names real ones (desktop ADR-0028 Decision 8, terse half).
  //
  // Absent and empty are different answers and the adapter renders them
  // differently: `undefined` means the caller never looked, so the prompt
  // says nothing about tables at all; `[]` means it looked and the
  // connection has none, which is worth telling the model because it
  // stops a confident invention. Optional so a caller that cannot
  // introspect keeps today's behaviour exactly.
  schema?: TableInfo[];
}

export interface AiResponse {
  // The natural-language answer (explanation, suggested SQL, etc.).
  text: string;
  // The model id the upstream actually served the response with. Useful
  // for downstream observability when an alias resolves to a concrete
  // version (e.g. `claude-sonnet-4-6` → `claude-sonnet-4-6-20260120`).
  model: string;
  // Cumulative token counts at terminal time, or null when the provider
  // surfaced none. Adapters must not synthesise an estimate: null means
  // "not reported", and a fabricated number would be indistinguishable
  // from a measured one in the history log.
  tokensIn: number | null;
  tokensOut: number | null;
  // Terminal reason, normalised to the history v:2 vocabulary
  // (`end_turn` | `max_tokens` | `stop_sequence` | `tool_use` |
  // `refusal` | `other:<text>`), or null when unreported. Informational
  // only — never branch on it.
  stopReason: string | null;
}

// The normalised stream vocabulary (desktop ADR-0026 Decision 3). It is
// deliberately not Anthropic's event shape: the port stays
// provider-independent, and web has a second reason desktop does not —
// these variants are serialised onto an SSE wire that a browser parses,
// so a passthrough would make the browser Anthropic-shaped too.
//
// Two deviations from desktop's enum, both because web has a wire where
// desktop has a channel:
//   - `message_start` carries the served model. Desktop reads it off the
//     atomic `AiResponse`; a stream has no such envelope, and both the
//     history record and the panel's model line need it.
//   - `error` is data rather than a thrown result. By the time a stream
//     fails the 200 has already gone out, so the failure has to travel
//     in-band or not at all.
export type StreamEvent =
  | { type: "message_start"; tokensIn: number | null; model: string | null }
  | { type: "text_delta"; text: string }
  // Cumulative counts, not increments — replace the meter, never add to
  // it (ADR-0026 Decision 7). `null` means this event reported none, and
  // the previous value stands.
  | { type: "usage"; tokensIn: number | null; tokensOut: number | null }
  | { type: "message_stop"; stopReason: string | null }
  | { type: "error"; category: AiErrorCategory; message: string };

export interface AiStreamOptions {
  // Cancellation is the caller's, and it reaches the transport rather
  // than merely stopping the reader: dropping the output while the
  // upstream keeps generating bills for tokens nobody receives.
  signal?: AbortSignal;
}

export interface AiProvider {
  getId(): string;
  // The model this provider is configured to call. Separate from
  // `AiResponse.model` (which reports what actually answered) because
  // history v:2 requires a non-empty `model` on the *error* path too,
  // where there is no response to read one from.
  getModel(): string;
  getCapabilities(): AiCapabilities;
  explain(request: ExplainRequest): Promise<AiResponse>;
  suggestSql(request: SuggestRequest): Promise<AiResponse>;
  // Optional, which is how TypeScript spells the default trait method
  // desktop gets for free (ADR-0026 Decision 2). A provider that leaves
  // them out is not excluded from the streaming surface — ai-stream.ts
  // delegates to the atomic call and yields the answer as one chunk —
  // so callers never branch on which kind of provider they hold.
  streamExplain?(request: ExplainRequest, options?: AiStreamOptions): AsyncIterable<StreamEvent>;
  streamSuggestSql?(request: SuggestRequest, options?: AiStreamOptions): AsyncIterable<StreamEvent>;
}

// DI token. Provider may be `undefined` when no env-var key is
// configured — consumers MUST mark the injection `@Optional()`.
export const AI_PROVIDER = Symbol("AI_PROVIDER");
