import { CategorizedError, type ErrorCategory } from "./categorized-error";

// Raised when a write was well-formed and permitted but did not land on
// exactly the row it was aimed at — the row was changed or deleted since it
// was loaded, or the key it was built from turned out not to be unique.
// Maps to HTTP 409 in ContractErrorFilter.
//
// Deliberately not a QueryError: nothing about the request was wrong, so
// telling the client "bad request" would send it looking in the wrong place.
// The correct client response is to reload and retry, which is what 409 says.
export class ConflictError extends CategorizedError {
  readonly category: ErrorCategory = "conflict";
}
