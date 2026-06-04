import { CategorizedError, type ErrorCategory } from "./categorized-error";

// Raised when an upstream value cannot be represented in the domain
// `Value` set (e.g. NUMERIC out of i64 range). Maps to HTTP 422.
export class TypeConversionError extends CategorizedError {
  readonly category: ErrorCategory = "type_conversion";
}
