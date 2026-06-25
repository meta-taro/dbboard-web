// Stage 1 keeps a single AI error class. Subclassing into auth /
// rate-limit / network categories is deferred until a consumer needs
// to discriminate (e.g. a future `POST /ai/*` controller mapping to
// HTTP status). Deliberately does NOT extend `CategorizedError` —
// `docs/api-contract.md` has no AI error category (desktop ADR-0023
// Decision 3 keeps AI off the wire).

export class AiError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}
