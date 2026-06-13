/**
 * Pure value-to-cell formatter for the SQL result grid.
 *
 * Returns both a discriminated `kind` (so the grid can style by type
 * without re-parsing) and the display `text`. The literals `"NULL"` and
 * `"<blob: N chars>"` are SQL/technical, not user-facing copy, so they
 * are deliberately not routed through vue-i18n.
 */
import type { BlobValue, Value } from "../composables/useQueryExecution";

export type FormattedKind = "null" | "number" | "string" | "blob";

export interface FormattedValue {
  kind: FormattedKind;
  text: string;
}

function isBlob(value: unknown): value is BlobValue {
  return typeof value === "object" && value !== null && "$blob" in value;
}

export function formatValue(value: Value): FormattedValue {
  if (value === null) {
    return { kind: "null", text: "NULL" };
  }
  if (typeof value === "number") {
    return { kind: "number", text: String(value) };
  }
  if (typeof value === "string") {
    return { kind: "string", text: value };
  }
  if (isBlob(value)) {
    return { kind: "blob", text: `<blob: ${value.$blob.length} chars>` };
  }
  // Unreachable given the Value union, but TypeScript requires
  // exhaustiveness — keep the string-cast fallback rather than
  // throwing so a driver returning an unexpected shape still renders.
  return { kind: "string", text: String(value) };
}
