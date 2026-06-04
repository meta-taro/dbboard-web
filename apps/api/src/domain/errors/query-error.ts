import { CategorizedError, type ErrorCategory } from "./categorized-error";

// Raised when the SQL statement is the caller's fault (syntax, missing
// column, type mismatch). Maps to HTTP 400 in ContractErrorFilter.
export class QueryError extends CategorizedError {
  readonly category: ErrorCategory = "query";
}
