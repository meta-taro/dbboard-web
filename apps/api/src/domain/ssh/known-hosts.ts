import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * An OpenSSH `known_hosts` reader, enough of one to answer the only question
 * ADR-0069 asks of it.
 *
 * Desktop delegates this to russh, whose `check_server_key` returns three
 * distinguishable outcomes: `Ok(true)` accept, `Ok(false)` unknown host,
 * `Err(_)` the host is known and the key changed. Web has no equivalent —
 * `ssh2` ships no `known_hosts` support at all — so the three-valued answer
 * is written out here rather than collapsed into a boolean. The collapse is
 * exactly what the ADR forbids: "unknown host, pin it before connecting" and
 * "KEY MISMATCH, possible man-in-the-middle" are different sentences for the
 * operator and must stay different.
 *
 * Not supported, deliberately: `@cert-authority` lines. We do not validate
 * certificates, and reading a CA key as if it were the host's own key would
 * accept the wrong thing — so those lines are skipped rather than honoured.
 */
export type KnownHostsVerdict = "match" | "unknown" | "mismatch";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

interface Entry {
  marker: string;
  patterns: string;
  key: Buffer;
}

function parseLine(raw: string): Entry | null {
  const line = raw.trim();
  if (line === "" || line.startsWith("#")) return null;

  let fields = line.split(/\s+/);
  let marker = "";
  if (fields[0]?.startsWith("@")) {
    marker = fields[0];
    fields = fields.slice(1);
  }

  // patterns, keytype, base64 — a comment may follow and is ignored.
  const [patterns, , encoded] = fields;
  if (patterns === undefined || encoded === undefined) return null;
  if (!BASE64.test(encoded)) return null;

  return { marker, patterns, key: Buffer.from(encoded, "base64") };
}

/** Translate one OpenSSH host pattern into a regex. `*` spans dots. */
function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const expanded = escaped.replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${expanded}$`);
}

function plainPatternsMatch(patterns: string, name: string): boolean {
  let matched = false;
  for (const pattern of patterns.split(",")) {
    const negated = pattern.startsWith("!");
    const body = negated ? pattern.slice(1) : pattern;
    if (body === "") continue;
    if (!patternToRegExp(body.toLowerCase()).test(name)) continue;
    // A negation kills the whole line, however many other patterns matched.
    if (negated) return false;
    matched = true;
  }
  return matched;
}

function hashedPatternMatches(patterns: string, name: string): boolean | null {
  if (!patterns.startsWith("|1|")) return null;
  const [, , salt, hash] = patterns.split("|");
  if (salt === undefined || hash === undefined) return false;
  if (!BASE64.test(salt) || !BASE64.test(hash)) return false;

  const expected = Buffer.from(hash, "base64");
  const actual = createHmac("sha1", Buffer.from(salt, "base64")).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function entryCoversHost(entry: Entry, name: string): boolean {
  const hashed = hashedPatternMatches(entry.patterns, name);
  return hashed ?? plainPatternsMatch(entry.patterns, name);
}

/**
 * The name OpenSSH files a host under: bare for port 22, `[host]:port`
 * otherwise. Keeping them separate is the point — a key pinned for one
 * service on a box should not vouch for another service on the same box.
 */
export function knownHostsName(host: string, port: number): string {
  const lower = host.toLowerCase();
  return port === 22 ? lower : `[${lower}]:${port}`;
}

/**
 * Decide what a `known_hosts` file says about the key this host just
 * presented.
 *
 * A `@revoked` line naming the presented key outranks everything: it is an
 * explicit refusal, not the absence of an acceptance.
 */
export function checkKnownHosts(
  text: string,
  host: string,
  port: number,
  hostKey: Uint8Array,
): KnownHostsVerdict {
  const name = knownHostsName(host, port);
  const presented = Buffer.from(hostKey);

  let sawHost = false;
  let accepted = false;

  for (const raw of text.split(/\r?\n/)) {
    const entry = parseLine(raw);
    if (entry === null) continue;
    if (entry.marker === "@cert-authority") continue;
    if (!entryCoversHost(entry, name)) continue;

    const sameKey = entry.key.length === presented.length && timingSafeEqual(entry.key, presented);

    if (entry.marker === "@revoked") {
      if (sameKey) return "mismatch";
      continue;
    }

    sawHost = true;
    // Not an early return: a later @revoked line still has to be able to
    // veto this acceptance.
    if (sameKey) accepted = true;
  }

  if (accepted) return "match";
  return sawHost ? "mismatch" : "unknown";
}
