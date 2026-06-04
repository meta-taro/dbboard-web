// Conformance-grade equality. The contract pins JSON envelopes to deep
// equality, but explicitly carves out `capabilities.id`: desktop returns
// the wired adapter id (`postgres`, `sqlite`, …) and web returns
// whatever the connection was registered as (`postgres`, `null`, …).
// Plain-text bodies (400/413/415 request-level rejections) carry no
// wording guarantee — only the status code and the content-type are
// pinned — so we relax to a case-insensitive substring containment
// check on a small set of contract-mandated tokens.
//
// Returning `null` on success keeps the call site terse:
//   expect(compareEnvelopes(desktop, web)).toBeNull();

export interface ConformanceResponse {
  readonly status: number;
  readonly contentType: string;
  readonly body: unknown;
  readonly text: string;
}

export function normalizeContentType(value: string | undefined): string {
  if (!value) return "";
  // Strip charset / boundary suffixes; only the media type is pinned.
  return value.split(";")[0].trim().toLowerCase();
}

export interface CompareOptions {
  // Tokens that **must** appear (case-insensitive) in both plain-text
  // bodies. Useful for the "10,000-row cap" / "Payload Too Large"
  // assertions where the contract specifies intent without wording.
  readonly plainTextTokens?: readonly string[];
  // Properties at the top level that are explicitly allowed to differ.
  // The conformance ticket calls out `capabilities.id`; pass `["id"]`
  // for that case.
  readonly ignoreTopLevelKeys?: readonly string[];
}

export function compareEnvelopes(
  desktop: ConformanceResponse,
  web: ConformanceResponse,
  opts: CompareOptions = {},
): string | null {
  if (desktop.status !== web.status) {
    return `status mismatch: desktop=${desktop.status} web=${web.status}`;
  }
  const dCT = normalizeContentType(desktop.contentType);
  const wCT = normalizeContentType(web.contentType);
  if (dCT !== wCT) {
    return `content-type mismatch: desktop=${dCT} web=${wCT}`;
  }

  if (dCT === "text/plain") {
    for (const token of opts.plainTextTokens ?? []) {
      const needle = token.toLowerCase();
      if (!desktop.text.toLowerCase().includes(needle)) {
        return `desktop plain-text body missing token "${token}": ${desktop.text}`;
      }
      if (!web.text.toLowerCase().includes(needle)) {
        return `web plain-text body missing token "${token}": ${web.text}`;
      }
    }
    return null;
  }

  // JSON path — both bodies are parsed objects.
  const dBody = stripKeys(desktop.body, opts.ignoreTopLevelKeys);
  const wBody = stripKeys(web.body, opts.ignoreTopLevelKeys);
  if (!deepEqual(dBody, wBody)) {
    return `JSON body mismatch:\n  desktop=${JSON.stringify(dBody)}\n  web=${JSON.stringify(wBody)}`;
  }
  return null;
}

function stripKeys(value: unknown, keys: readonly string[] | undefined): unknown {
  if (!keys || keys.length === 0) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!keys.includes(k)) out[k] = v;
  }
  return out;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== "object") return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i += 1) {
      if (!deepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  const aRec = a as Record<string, unknown>;
  const bRec = b as Record<string, unknown>;
  const aKeys = Object.keys(aRec).sort();
  const bKeys = Object.keys(bRec).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i += 1) {
    if (aKeys[i] !== bKeys[i]) return false;
    if (!deepEqual(aRec[aKeys[i]], bRec[bKeys[i]])) return false;
  }
  return true;
}
