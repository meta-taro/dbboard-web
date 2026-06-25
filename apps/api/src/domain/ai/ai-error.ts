import { CategorizedError, type ErrorCategory } from "../errors/categorized-error";

// AiError is the adapter-internal error class — thrown by the
// Anthropic adapter (Slice 1) when an upstream call fails or the
// response is unusable. It is NOT a CategorizedError because the
// adapter has no view of the wire envelope; the use-case layer
// translates AiError into AiUpstreamError (below) so the wire
// mapping stays at the presentation seam.

export class AiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

// AiDisabledError → HTTP 404 via ContractErrorFilter. Mirrors the
// `capability` precedent: the route exists in code but the deployment
// has not configured an AI provider, so the UI should hide the AI
// feature rather than surface it as a query error.
export class AiDisabledError extends CategorizedError {
  readonly category: ErrorCategory = "ai_disabled";
}

// AiUpstreamError → HTTP 502 via ContractErrorFilter. Mirrors the
// `connection` precedent: a third-party upstream (Anthropic) failed.
// Use-cases wrap the adapter's AiError in this so the cause survives
// for diagnostics without leaking SDK internals to the wire.
export class AiUpstreamError extends CategorizedError {
  readonly category: ErrorCategory = "ai_provider";
}
