/**
 * Pure value-to-cell formatter for the SQL result grid.
 *
 * Returns both a discriminated `kind` (so the grid can style by type
 * without re-parsing) and the display `text`. The literals `"NULL"` and
 * `"<blob: N chars>"` are SQL/technical, not user-facing copy, so they
 * are deliberately not routed through vue-i18n.
 *
 * `kind` is not merely a styling hint. A `Text` cell and a `$json` cell can
 * render to the same characters, and the tag on the wire is the only thing
 * that tells them apart — so the kind has to carry that distinction through
 * to the grid, or it is lost the moment the value is formatted.
 */
import type { BlobValue, JsonValue, Value } from "../composables/useQueryExecution";

export type FormattedKind = "null" | "number" | "string" | "blob" | "json";

export interface FormattedValue {
  kind: FormattedKind;
  text: string;
}

function isBlob(value: unknown): value is BlobValue {
  return typeof value === "object" && value !== null && "$blob" in value;
}

function isJson(value: unknown): value is JsonValue {
  return typeof value === "object" && value !== null && "$json" in value;
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
  if (isJson(value)) {
    // The document's own JSON text, matching desktop's `displayCell`. Not
    // summarised the way a blob is: the payload is the value, it is already
    // text, and the contract asks for it readable. Checked after `isBlob` and
    // never recursed into — a payload holding a "$blob" key is part of the
    // document, not a blob.
    return { kind: "json", text: JSON.stringify(value.$json) };
  }
  // Unreachable given the Value union, but TypeScript requires
  // exhaustiveness — keep the string-cast fallback rather than
  // throwing so a driver returning an unexpected shape still renders.
  return { kind: "string", text: String(value) };
}
