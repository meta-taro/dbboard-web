import { CategorizedError, type ErrorCategory } from "./categorized-error";

// Raised when schema introspection (e.g. `GET /tables`) fails upstream.
// Same HTTP 502 mapping as ConnectionError — the gateway tried, the
// backend gave it something it can't translate to the contract shape.
export class SchemaError extends CategorizedError {
  readonly category: ErrorCategory = "schema";
}
