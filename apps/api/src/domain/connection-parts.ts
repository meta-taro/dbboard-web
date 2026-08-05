import { hardenSslMode, type SslMode } from "./ssl-mode";

/**
 * The half of a connection's configuration that is safe to remember: where it
 * points, who it connects as, and how it is protected in transit.
 *
 * **There is no `password` member, and the absence is the design** (desktop
 * ADR-0080). Web is blocked from an edit form for the reason desktop was —
 * "the process holding the credential refused to say anything at all about it,
 * including the parts that are not secret" — and the way out is not to relax
 * the leak rule but to name the non-secret parts separately. A prefill payload
 * built from this type cannot leak a password by oversight, because there is
 * nowhere to put one.
 *
 * Every member is optional. What is known depends on how the connection was
 * registered: a pasted URL may name no user, a `null`-driver connection names
 * nothing at all.
 */
export interface ConnectionParts {
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  sslMode?: SslMode;
}

/**
 * What `connectionPartsOf` reads. Structurally a subset of `AdapterConfig`, so
 * a config can be passed straight in — but declared here, in `domain`, both
 * because a usecase-layer import would invert the layering (§9) and because
 * the parameter type is itself part of the guarantee: **it does not name
 * `password`, so the function body cannot read one off a split-fields config**.
 *
 * `connectionString` is the exception that has to be handled rather than
 * typed away: a DSN carries the password inside it, so that branch discards it
 * deliberately.
 */
export interface ConnectionPartsSource {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  sslMode?: SslMode;
}

function partsFromUrl(text: string): ConnectionParts {
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    // Not this function's error to raise. A driver that ignores
    // `connectionString` still passes through here, and the adapter that does
    // read it reports the malformed value with a message about the driver.
    return {};
  }

  const parts: ConnectionParts = {};

  // `URL.hostname` keeps the brackets on an IPv6 literal (`[::1]`). They are a
  // URL delimiter, not part of the address, and a host box wants the address.
  const host = url.hostname.replace(/^\[/, "").replace(/\]$/, "");
  if (host !== "") parts.host = host;

  if (url.port !== "") parts.port = Number(url.port);

  // Percent-escapes are undone: what comes back has to be what the user would
  // type into the boxes, not the URL spelling of it. `decodeURIComponent`
  // throws on a malformed escape, so each field falls back to being unknown
  // rather than taking the whole parse down with it.
  const database = decodeOrUndefined(url.pathname.replace(/^\//, ""));
  if (database !== undefined && database !== "") parts.database = database;

  const user = decodeOrUndefined(url.username);
  if (user !== undefined && user !== "") parts.user = user;

  // Hardened, not echoed. `prefer` means "try TLS, accept plaintext", which
  // slice A removed as a possible outcome — reporting it would prefill a
  // select with a mode the adapter does not implement.
  const sslmode = url.searchParams.get("sslmode");
  if (sslmode !== null) parts.sslMode = hardenSslMode(sslmode);

  // `url.password` is never read. That is the whole point of the branch.
  return parts;
}

function decodeOrUndefined(raw: string): string | undefined {
  try {
    return decodeURIComponent(raw);
  } catch {
    return undefined;
  }
}

/**
 * The non-secret parts of a registration, or `undefined` when it has none.
 *
 * `undefined` rather than `{}` because they are different facts. A
 * `null`-driver connection connects to no host, and an empty object would be a
 * claim about a connection that has no address at all.
 *
 * Precedence mirrors `resolvePostgresPoolOptions` exactly, and has to: parts
 * that disagreed with the pool options would describe a connection nobody
 * made. A `connectionString` supplants the split fields wholesale (libpq's own
 * rule), while an explicit `sslMode` outranks the URL's, because it is a claim
 * about which option the form's select was on.
 */
export function connectionPartsOf(source: ConnectionPartsSource): ConnectionParts | undefined {
  const parts: ConnectionParts =
    source.connectionString === undefined
      ? pickFields(source)
      : partsFromUrl(source.connectionString);

  if (source.sslMode !== undefined) parts.sslMode = source.sslMode;

  return Object.keys(parts).length === 0 ? undefined : parts;
}

function pickFields(source: ConnectionPartsSource): ConnectionParts {
  const parts: ConnectionParts = {};
  if (source.host !== undefined) parts.host = source.host;
  if (source.port !== undefined) parts.port = source.port;
  if (source.database !== undefined) parts.database = source.database;
  if (source.user !== undefined) parts.user = source.user;
  return parts;
}
