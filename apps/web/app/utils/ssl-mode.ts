/**
 * The TLS vocabulary the connection form speaks, and how to read it out of
 * a pasted URL.
 *
 * The API owns this rule — `apps/api/src/domain/ssl-mode.ts` hardens every
 * inbound mode and is the only place a connection is actually decided. This
 * copy exists so the select can display the mode that will result rather
 * than the one the URL text names, which are not always the same word. If
 * the two ever disagree the API is right and this is the bug; the pairing
 * is pinned on both sides by tests naming the same inputs.
 */

// Exactly what `POST /connections` accepts as an `sslMode` field. Anything
// else is a 422 there, so offering a third option would be offering a
// choice that fails on submit.
export const SSL_MODES = ["require", "disable"] as const;

export type SslMode = (typeof SSL_MODES)[number];

// Mirrors the API's `hardenSslMode`. Everything that is not a knowing
// opt-out resolves to `require`: a connection the user believes is
// encrypted and is not is worse than one they turned off on purpose.
export function hardenSslMode(supplied: string | null | undefined): SslMode {
  return supplied === "disable" ? "disable" : "require";
}

/**
 * What a pasted connection string will actually get, or `undefined` when
 * the text has no opinion.
 *
 * The distinction matters: `undefined` must not be flattened to `require`,
 * because a URL that says nothing is not a reason to discard a mode the
 * user picked in the select. Only a URL that states one moves it.
 *
 * Unparseable text is also `undefined` rather than an error — this runs on
 * every keystroke, so most of what it sees is a half-typed URL.
 */
export function readSslModeFromUrl(text: string): SslMode | undefined {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    return undefined;
  }
  const stated = url.searchParams.get("sslmode");
  return stated === null ? undefined : hardenSslMode(stated);
}
