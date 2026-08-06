import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { fingerprintMatches, normalizeFingerprint, sha256Fingerprint } from "./fingerprint";

describe("normalizeFingerprint", () => {
  it("strips the SHA256: prefix", () => {
    expect(normalizeFingerprint("SHA256:abc123")).toBe("abc123");
  });

  it("strips surrounding whitespace", () => {
    expect(normalizeFingerprint("  SHA256:abc123  ")).toBe("abc123");
  });

  it("strips whitespace left behind by the prefix", () => {
    expect(normalizeFingerprint("SHA256: abc123")).toBe("abc123");
  });

  it("leaves a bare body untouched", () => {
    expect(normalizeFingerprint("abc123")).toBe("abc123");
  });
});

describe("fingerprintMatches", () => {
  it("matches with or without the prefix on either side", () => {
    expect(fingerprintMatches("SHA256:abc123", "abc123")).toBe(true);
    expect(fingerprintMatches("abc123", "SHA256:abc123")).toBe(true);
  });

  it("is case-sensitive in the body", () => {
    // The body is base64, where case carries a bit. Folding it would let two
    // different keys compare equal.
    expect(fingerprintMatches("SHA256:AbC123", "SHA256:abc123")).toBe(false);
  });

  it("rejects a different key", () => {
    expect(fingerprintMatches("SHA256:abc123", "SHA256:def456")).toBe(false);
  });

  it("never matches an empty expectation", () => {
    // A blank pin must fail closed. The alternative — treating "" as
    // "anything" — is the blind-accept mode ADR-0069 refuses to have.
    expect(fingerprintMatches("", "abc123")).toBe(false);
    expect(fingerprintMatches("SHA256:", "abc123")).toBe(false);
    expect(fingerprintMatches("   ", "abc123")).toBe(false);
  });

  it("never matches an empty presentation either", () => {
    expect(fingerprintMatches("abc123", "")).toBe(false);
  });
});

describe("sha256Fingerprint", () => {
  it("renders OpenSSH's SHA256: form of a host key blob", () => {
    const key = Buffer.from("a host key blob", "utf8");
    const expected = createHash("sha256").update(key).digest("base64").replace(/=+$/, "");

    expect(sha256Fingerprint(key)).toBe(`SHA256:${expected}`);
  });

  it("strips base64 padding, as ssh-keygen does", () => {
    // `ssh-keygen -lf` prints the digest unpadded; a pin copied from its
    // output would never match a padded rendering.
    expect(sha256Fingerprint(Buffer.from("x"))).not.toMatch(/=/);
  });

  it("accepts a plain Uint8Array", () => {
    const bytes = new Uint8Array([1, 2, 3]);
    expect(sha256Fingerprint(bytes)).toBe(sha256Fingerprint(Buffer.from(bytes)));
  });
});
