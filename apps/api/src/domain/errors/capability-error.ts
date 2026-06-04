import { CategorizedError, type ErrorCategory } from "./categorized-error";

// Raised when the adapter does not implement the requested capability
// (ADR-0012). Distinct from QueryError so the UI can hide / grey out
// the feature instead of surfacing it as a SQL error. Maps to HTTP 404.
export class CapabilityError extends CategorizedError {
  readonly category: ErrorCategory = "capability";
}
