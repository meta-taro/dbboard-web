import { createHash } from "node:crypto";

/**
 * SHA-256 host-key fingerprints, in the form `ssh-keygen -lf` prints them.
 *
 * Mirrors desktop `crates/dbboard-tunnel/src/fingerprint.rs`. The one rule
 * worth restating: a blank expectation never matches. ADR-0069 has no
 * blind-accept variant in the type, and an empty pin silently meaning
 * "anything" would put one back in through the side door.
 */

const SHA256_PREFIX = "SHA256:";

/** Strip the `SHA256:` label and any surrounding whitespace. */
export function normalizeFingerprint(fingerprint: string): string {
  const trimmed = fingerprint.trim();
  const body = trimmed.startsWith(SHA256_PREFIX) ? trimmed.slice(SHA256_PREFIX.length) : trimmed;
  return body.trim();
}

/**
 * Whether a presented key's fingerprint is the pinned one.
 *
 * The comparison is case-sensitive: the body is base64, where case carries a
 * bit, so folding it would let two different keys compare equal.
 */
export function fingerprintMatches(expected: string, actual: string): boolean {
  const want = normalizeFingerprint(expected);
  const got = normalizeFingerprint(actual);
  return want !== "" && want === got;
}

/**
 * Render a raw host-key blob as OpenSSH does — base64 of the SHA-256 digest,
 * padding stripped, under a `SHA256:` label. Padding matters: a pin copied
 * out of `ssh-keygen -lf` is unpadded and would never match a padded form.
 */
export function sha256Fingerprint(hostKey: Uint8Array): string {
  const digest = createHash("sha256").update(hostKey).digest("base64").replace(/=+$/, "");
  return `${SHA256_PREFIX}${digest}`;
}
