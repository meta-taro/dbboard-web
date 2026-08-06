/**
 * The two browser primitives a file download needs, behind named exports so
 * composable tests can `vi.mock` them — the same indirection `internal/http`
 * provides for `$fetch`.
 *
 * A download does not go through `$fetch`: it needs the raw Response. The
 * status code separates the size gate (400, a question) from a real failure,
 * `Content-Disposition` carries the filename the server chose, and the body
 * has to stay a Blob rather than be parsed as JSON.
 */

/** Forwards 1:1 to the platform `fetch`. */
export function rawFetch(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

/** Hand `blob` to the browser as a download named `filename`. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  // Firefox historically ignored a click on a detached anchor.
  document.body.append(anchor);
  try {
    anchor.click();
  } finally {
    anchor.remove();
    URL.revokeObjectURL(url);
  }
}
