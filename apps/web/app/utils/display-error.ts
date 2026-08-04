// One shape for every error the app puts on screen, carrying the message the
// user can read and the English one they can search. Desktop ADR-0039.
//
// The English half is read from the `en` bundle directly rather than through
// `t(key, { locale: "en" })`. Locale files are lazy-loaded (`i18n.lazy` in
// nuxt.config.ts), so on a Japanese session the English bundle may simply not
// be in memory, and a half that is sometimes the key and sometimes the
// sentence is worse than no half at all. The import costs a few kilobytes and
// cannot drift, because it is the same file the localized half comes from.
//
// It is imported `?raw` and parsed here. A plain JSON import of a locale file
// does not yield the JSON: @nuxtjs/i18n compiles those into vue-i18n message
// AST nodes, so `en.error.prefix.query` would be an object, and interpolating
// it produces "[object Object]" rather than a prefix. Taking the text and
// parsing it ourselves is the same trick i18n-locale-parity.test.ts uses, for
// the same reason.
//
// What is NOT translated: the message body. It comes from the connection
// target — a Postgres or libSQL engine — not from dbboard, so translating it
// would mean inventing wording for someone else's error. ADR-0039 draws the
// same boundary, and it is why both halves below share one body.

import enSource from "../../i18n/locales/en.json?raw";

const EN: unknown = JSON.parse(enSource);

export interface DisplayError {
  /** What the user reads, in the active locale. */
  readonly localized: string;
  /** The same error in English, for a web search or an assistant. */
  readonly original: string;
}

/** An error that travelled up from a lower layer, so it has an English form. */
export function displayError(localized: string, original: string): DisplayError {
  return { localized, original };
}

/**
 * An error with no lower layer to have come from — a UI-side validation.
 *
 * Both halves are the same text, which is not a special case anywhere below:
 * `hasOriginal` reports false and the clipboard gets one line, exactly as it
 * does for an error whose translation happens to be its original.
 */
export function plainError(text: string): DisplayError {
  return { localized: text, original: text };
}

/** Whether the English half says anything the localized half does not. */
export function hasOriginal(error: DisplayError): boolean {
  return error.localized !== error.original;
}

/** What the copy button puts on the clipboard. */
export function errorClipboardText(error: DisplayError): string {
  return hasOriginal(error) ? `${error.localized}\n${error.original}` : error.localized;
}

/**
 * A translated prefix in front of an untranslated body.
 *
 * This is the general shape every error site in the app has: a key naming what
 * failed, and — usually — a sentence from underneath saying why. Pass `null`
 * for `message` when there is nothing underneath, as with a failure the client
 * itself detected.
 *
 * `translate` is passed in rather than imported so this stays a pure function
 * of its arguments — the caller hands it vue-i18n's `t`.
 */
export function prefixed(
  i18nKey: string,
  message: string | null,
  translate: (key: string) => string,
): DisplayError {
  return displayError(
    join(translate(i18nKey), message, i18nKey),
    join(englishText(i18nKey), message, i18nKey),
  );
}

/** The wire's categorised error, in both halves. */
export function fromCategorised(
  error: { message: string; i18nKey: string },
  translate: (key: string) => string,
): DisplayError {
  return prefixed(error.i18nKey, error.message, translate);
}

/**
 * The English wording for a key, or nothing if the bundle has no such key.
 *
 * Any dotted key resolves, not just `error.prefix.*` — a schema browser saying
 * "Schema error" and a connection saying "Connection error" both deserve the
 * searchable half, and they name their prefix differently.
 */
function englishText(i18nKey: string): string | null {
  let node: unknown = EN;
  for (const part of i18nKey.split(".")) {
    if (node === null || typeof node !== "object") return null;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : null;
}

/**
 * A prefix and a body, or whichever of the two there is.
 *
 * A prefix that did not resolve is dropped rather than rendered: the body is
 * the half carrying the information, and showing `error.prefix.whatever:` in
 * front of it would cost the reader something and give nothing back. With no
 * body either there is nothing left to show, so the key goes on screen — the
 * visible degradation ADR-0039 asks for, rather than an empty red box.
 */
function join(prefix: string | null, message: string | null, i18nKey: string): string {
  if (prefix === null) return message ?? i18nKey;
  return message === null ? prefix : `${prefix}: ${message}`;
}
