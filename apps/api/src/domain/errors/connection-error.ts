import { CategorizedError, type ErrorCategory } from "./categorized-error";

// Raised when the upstream database is unreachable or refuses the
// connection. Maps to HTTP 502 — the caller is fine, the gateway can't
// reach its backend.
export class ConnectionError extends CategorizedError {
  readonly category: ErrorCategory = "connection";
}
