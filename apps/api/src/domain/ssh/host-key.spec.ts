import { describe, expect, it } from "vitest";

import { sha256Fingerprint } from "./fingerprint";
import { verifyHostKey } from "./host-key";

const KEY = Buffer.from("the server's public key blob", "utf8");
const OTHER_KEY = Buffer.from("somebody else's public key blob", "utf8");

function knownHostsLine(patterns: string, key: Buffer = KEY): string {
  return `${patterns} ssh-ed25519 ${key.toString("base64")}`;
}

describe("verifyHostKey — pinned fingerprint", () => {
  it("accepts the pinned key", () => {
    const policy = { kind: "fingerprint", fingerprint: sha256Fingerprint(KEY) } as const;
    expect(verifyHostKey(policy, "bastion.example.com", 22, KEY)).toEqual({ accepted: true });
  });

  it("accepts a pin written without the SHA256: label", () => {
    const bare = sha256Fingerprint(KEY).replace("SHA256:", "");
    const policy = { kind: "fingerprint", fingerprint: bare } as const;
    expect(verifyHostKey(policy, "bastion.example.com", 22, KEY).accepted).toBe(true);
  });

  it("rejects another key, naming both fingerprints", () => {
    const policy = { kind: "fingerprint", fingerprint: sha256Fingerprint(KEY) } as const;
    const verdict = verifyHostKey(policy, "bastion.example.com", 22, OTHER_KEY);

    expect(verdict.accepted).toBe(false);
    expect(verdict.reason).toContain("fingerprint mismatch");
    expect(verdict.reason).toContain(sha256Fingerprint(KEY));
    expect(verdict.reason).toContain(sha256Fingerprint(OTHER_KEY));
  });

  it("rejects a blank pin rather than reading it as 'anything'", () => {
    const policy = { kind: "fingerprint", fingerprint: "   " } as const;
    expect(verifyHostKey(policy, "bastion.example.com", 22, KEY).accepted).toBe(false);
  });
});

describe("verifyHostKey — known_hosts", () => {
  it("accepts a listed key", () => {
    const policy = {
      kind: "known-hosts",
      knownHosts: knownHostsLine("bastion.example.com"),
    } as const;
    expect(verifyHostKey(policy, "bastion.example.com", 22, KEY)).toEqual({ accepted: true });
  });

  it("tells an unknown host apart from a changed key", () => {
    // The two sentences are the whole reason this is three-valued: one asks
    // the operator to pin a key, the other warns them not to (ADR-0069).
    const policy = {
      kind: "known-hosts",
      knownHosts: knownHostsLine("bastion.example.com"),
    } as const;

    const unknown = verifyHostKey(policy, "other.example.com", 22, KEY);
    expect(unknown.accepted).toBe(false);
    expect(unknown.reason).toContain("unknown host");
    expect(unknown.reason).toContain("other.example.com");
    expect(unknown.reason).toContain("pin it before connecting");

    const changed = verifyHostKey(policy, "bastion.example.com", 22, OTHER_KEY);
    expect(changed.accepted).toBe(false);
    expect(changed.reason).toContain("KEY MISMATCH");
    expect(changed.reason).toContain("man-in-the-middle");
  });

  it("names the port form it looked the host up under", () => {
    const policy = { kind: "known-hosts", knownHosts: "" } as const;
    const verdict = verifyHostKey(policy, "bastion.example.com", 2222, KEY);

    expect(verdict.reason).toContain("[bastion.example.com]:2222");
  });

  it("rejects an empty known_hosts as unknown, never as an accept", () => {
    const policy = { kind: "known-hosts", knownHosts: "" } as const;
    expect(verifyHostKey(policy, "bastion.example.com", 22, KEY).accepted).toBe(false);
  });
});
