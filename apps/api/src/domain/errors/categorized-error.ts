// Category strings are the wire-format contract (docs/api-contract.md §
// Errors). They double as the HTTP status mapping key inside
// ContractErrorFilter — adding a category here means adding a row to
// that filter's table, otherwise startup throws.

export type ErrorCategory = "query" | "type_conversion" | "connection" | "schema" | "capability";

export abstract class CategorizedError extends Error {
  abstract readonly category: ErrorCategory;

  constructor(message: string) {
    super(message);
    // Subclasses override `name` so logs / stack traces surface the
    // specific type (QueryError vs SchemaError) instead of the abstract
    // base. Without this, V8 reports "Error" for thrown instances.
    this.name = new.target.name;
  }
}
