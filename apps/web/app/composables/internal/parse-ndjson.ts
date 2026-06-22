/**
 * Pure NDJSON line splitter shared between history (slice 0015) and any
 * future read-side that wants to consume an `application/x-ndjson`
 * payload from the same-origin operator endpoints.
 *
 * The splitter never throws: malformed JSON lines are silently skipped
 * so a single bad line cannot poison the rest of the stream, and the
 * caller's `validate` returns `null` for shapes it does not recognise.
 * Both branches are the forward-compat policy from desktop ADR-0017 §6
 * ("readers tolerate unknown fields silently, drop records with unknown
 * `v` or `status`"). See `.claude/issues/0015-frontend-history-sidebar.md`.
 */
export function parseNdjson<T>(text: string, validate: (v: unknown) => T | null): T[] {
  const out: T[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const validated = validate(parsed);
    if (validated !== null) out.push(validated);
  }
  return out;
}
