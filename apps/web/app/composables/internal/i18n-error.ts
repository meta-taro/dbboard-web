/**
 * Shared bridge between the wire-format error envelope (ContractErrorFilter)
 * and the i18n key surface (`error.prefix.<category>`).
 *
 * The wire emits categories as underscore strings (`type_conversion`); en.json
 * inherits the desktop ADR-0015 hyphen spelling (`type-conversion`). Every
 * composable that consumes the envelope (so far: useConnections, and the SQL
 * editor's useQueryExecution) routes through this module so the bridge has
 * exactly one source of truth.
 */

export type ErrorCategory = "connection" | "query" | "schema" | "type_conversion" | "capability";

export interface CategorisedError {
  category: ErrorCategory;
  message: string;
  i18nKey: `error.prefix.${string}`;
}

interface BackendErrorShape {
  data?: { error?: { category?: string; message?: string } };
}

export function toI18nKey(category: ErrorCategory): `error.prefix.${string}` {
  const suffix = category === "type_conversion" ? "type-conversion" : category;
  return `error.prefix.${suffix}`;
}

export function parseError(err: unknown): CategorisedError {
  const envelope = (err as BackendErrorShape | null | undefined)?.data?.error;
  if (envelope && typeof envelope.category === "string" && typeof envelope.message === "string") {
    const category = envelope.category as ErrorCategory;
    return { category, message: envelope.message, i18nKey: toI18nKey(category) };
  }
  const message = err instanceof Error ? err.message : String(err);
  return {
    category: "connection",
    message,
    i18nKey: "error.prefix.connection",
  };
}
