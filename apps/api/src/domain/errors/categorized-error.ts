// Category strings are the wire-format error envelope shared by all
// categorised controllers in this service. The five categories below
// (query / type_conversion / connection / schema / capability) are
// mirrored from docs/api-contract.md — the cross-repo shared subset.
// The two AI categories (ai_disabled / ai_provider) are web-only —
// /ai/* routes exist only on this service per desktop ADR-0023
// Decision 3, so they live outside docs/api-contract.md but reuse the
// same envelope shape for client consistency.
//
// Adding a category here means adding a row to
// ContractErrorFilter.CATEGORY_STATUS, otherwise the filter throws.

export type ErrorCategory =
  | "query"
  | "type_conversion"
  | "connection"
  | "schema"
  | "capability"
  | "ai_disabled"
  | "ai_provider";

export abstract class CategorizedError extends Error {
  abstract readonly category: ErrorCategory;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    // Subclasses override `name` so logs / stack traces surface the
    // specific type (QueryError vs SchemaError) instead of the abstract
    // base. Without this, V8 reports "Error" for thrown instances.
    this.name = new.target.name;
    if (options?.cause !== undefined) {
      // ES2022 Error supports `cause` via the constructor options, but
      // CategorizedError calls `super(message)` only — preserving cause
      // for subclasses that opt in (AiUpstreamError) is done here.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}
