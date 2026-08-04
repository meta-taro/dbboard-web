import { CategorizedError, type ErrorCategory } from "../errors/categorized-error";

// AiError is the adapter-internal error class — thrown by the
// Anthropic adapter (Slice 1) when an upstream call fails or the
// response is unusable. It is NOT a CategorizedError because the
// adapter has no view of the wire envelope; the use-case layer
// translates AiError into AiUpstreamError (below) so the wire
// mapping stays at the presentation seam.

// The three AI failure categories recorded in history v:2 (desktop
// ADR-0023 §5, mirrored in `history-record.ts`). Deliberately distinct
// from the DB `ErrorCategory`: an AI call cannot fail with `schema`, and
// a query cannot fail with `provider`. `cancelled` is absent because
// cancel is a top-level status, not a failure (ADR-0026 Decision 12).
export type AiErrorCategory = "network" | "provider" | "configuration";

export class AiError extends Error {
  // Set by the adapter, which is the only layer that can tell a
  // transport failure from an upstream rejection. Without it every
  // recorded AI error would carry the same constant category, which is
  // the same as recording nothing.
  readonly category: AiErrorCategory;

  constructor(message: string, options?: { cause?: unknown; category?: AiErrorCategory }) {
    super(message, options);
    this.name = new.target.name;
    // "provider" is the honest default: the call reached the adapter and
    // failed, and nothing has proven the fault lies elsewhere.
    this.category = options?.category ?? "provider";
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
