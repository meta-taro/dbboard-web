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

export interface AiCapabilities {
  // Flat-bool, all-false default — mirrors desktop's `AiCapabilities`.
  // Streaming and function-calling are off in Stage 1 because the UI
  // and the Nest controller seam aren't wired for them yet. Flipping a
  // flag here also requires the adapter to actually implement it.
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
}

export interface AiResponse {
  // The natural-language answer (explanation, suggested SQL, etc.).
  text: string;
  // The model id the upstream actually served the response with. Useful
  // for downstream observability when an alias resolves to a concrete
  // version (e.g. `claude-sonnet-4-6` → `claude-sonnet-4-6-20260120`).
  model: string;
}

export interface AiProvider {
  getId(): string;
  getCapabilities(): AiCapabilities;
  explain(request: ExplainRequest): Promise<AiResponse>;
  suggestSql(request: SuggestRequest): Promise<AiResponse>;
}

// DI token. Provider may be `undefined` when no env-var key is
// configured — consumers MUST mark the injection `@Optional()`.
export const AI_PROVIDER = Symbol("AI_PROVIDER");
