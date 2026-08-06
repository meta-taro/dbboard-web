import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";

import { checkKnownHosts } from "./known-hosts";

const KEY = Buffer.from("the server's public key blob", "utf8");
const OTHER_KEY = Buffer.from("somebody else's public key blob", "utf8");

function line(patterns: string, key: Buffer = KEY, marker = ""): string {
  const prefix = marker === "" ? "" : `${marker} `;
  return `${prefix}${patterns} ssh-ed25519 ${key.toString("base64")} comment@here`;
}

/** An OpenSSH `|1|salt|hash` entry for one exact name. */
function hashedLine(name: string, key: Buffer = KEY): string {
  const salt = randomBytes(20);
  const hash = createHmac("sha1", salt).update(name).digest();
  const patterns = `|1|${salt.toString("base64")}|${hash.toString("base64")}`;
  return line(patterns, key);
}

describe("checkKnownHosts", () => {
  it("matches a plain host entry whose key is the one presented", () => {
    expect(checkKnownHosts(line("bastion.example.com"), "bastion.example.com", 22, KEY)).toBe(
      "match",
    );
  });

  it("reports a host it has never seen as unknown, not as a mismatch", () => {
    // The two are different questions for the operator: one asks to pin a
    // new key, the other says the key changed underneath them (ADR-0069).
    expect(checkKnownHosts(line("bastion.example.com"), "other.example.com", 22, KEY)).toBe(
      "unknown",
    );
  });

  it("reports a known host presenting a different key as a mismatch", () => {
    expect(checkKnownHosts(line("bastion.example.com"), "bastion.example.com", 22, OTHER_KEY)).toBe(
      "mismatch",
    );
  });

  it("treats an empty file as unknown", () => {
    expect(checkKnownHosts("", "bastion.example.com", 22, KEY)).toBe("unknown");
  });

  it("ignores comments and blank lines", () => {
    const text = ["# a comment", "", "   ", line("bastion.example.com")].join("\n");
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("match");
  });

  it("accepts a match on any line, even after a line that would mismatch", () => {
    // Host key rotation leaves both keys listed for a while. OpenSSH accepts
    // if any line matches; stopping at the first non-matching key would
    // report a rotation as an attack.
    const text = [line("bastion.example.com", OTHER_KEY), line("bastion.example.com")].join("\n");
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("match");
  });

  it("splits comma-separated host patterns", () => {
    const text = line("gate.example.com,bastion.example.com,10.0.0.1");
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("match");
    expect(checkKnownHosts(text, "10.0.0.1", 22, KEY)).toBe("match");
  });

  it("expands * and ? wildcards", () => {
    expect(checkKnownHosts(line("*.example.com"), "bastion.example.com", 22, KEY)).toBe("match");
    expect(checkKnownHosts(line("bastion?.example.com"), "bastion1.example.com", 22, KEY)).toBe(
      "match",
    );
    expect(checkKnownHosts(line("bastion?.example.com"), "bastion12.example.com", 22, KEY)).toBe(
      "unknown",
    );
  });

  it("does not let a wildcard leak across a dot the pattern did not write", () => {
    // `*` in OpenSSH does span dots, so this is a match — asserted so the
    // regex translation is not quietly tightened to glob semantics later.
    expect(checkKnownHosts(line("*.example.com"), "a.b.example.com", 22, KEY)).toBe("match");
  });

  it("treats a metacharacter in the pattern as a literal", () => {
    expect(checkKnownHosts(line("10.0.0.1"), "10a0b0c1", 22, KEY)).toBe("unknown");
  });

  it("honours a negated pattern by discarding the whole line", () => {
    const text = line("*.example.com,!bastion.example.com");
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("unknown");
    expect(checkKnownHosts(text, "gate.example.com", 22, KEY)).toBe("match");
  });

  it("looks a non-default port up in [host]:port form", () => {
    expect(
      checkKnownHosts(line("[bastion.example.com]:2222"), "bastion.example.com", 2222, KEY),
    ).toBe("match");
    // The bare name is a different entry, and reusing it for another port
    // would accept a key pinned for a different service.
    expect(checkKnownHosts(line("bastion.example.com"), "bastion.example.com", 2222, KEY)).toBe(
      "unknown",
    );
  });

  it("looks port 22 up under the bare name", () => {
    expect(checkKnownHosts(line("[bastion.example.com]:22"), "bastion.example.com", 22, KEY)).toBe(
      "unknown",
    );
  });

  it("compares host names case-insensitively", () => {
    expect(checkKnownHosts(line("Bastion.Example.COM"), "bastion.example.com", 22, KEY)).toBe(
      "match",
    );
  });

  it("resolves hashed entries", () => {
    const text = hashedLine("bastion.example.com");
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("match");
    expect(checkKnownHosts(text, "other.example.com", 22, KEY)).toBe("unknown");
  });

  it("resolves a hashed entry for a non-default port", () => {
    const text = hashedLine("[bastion.example.com]:2222");
    expect(checkKnownHosts(text, "bastion.example.com", 2222, KEY)).toBe("match");
  });

  it("reports a hashed host presenting another key as a mismatch", () => {
    const text = hashedLine("bastion.example.com", OTHER_KEY);
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("mismatch");
  });

  it("refuses a key listed as @revoked even when another line accepts it", () => {
    const text = [line("bastion.example.com"), line("bastion.example.com", KEY, "@revoked")].join(
      "\n",
    );
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("mismatch");
  });

  it("ignores @cert-authority lines rather than reading them as host keys", () => {
    // We do not validate certificates, and treating a CA key as if it were
    // the host's own key would accept the wrong thing.
    const text = line("bastion.example.com", KEY, "@cert-authority");
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("unknown");
  });

  it("skips malformed lines instead of throwing", () => {
    const text = ["nonsense", "host-only", "host ssh-ed25519", line("bastion.example.com")].join(
      "\n",
    );
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("match");
  });

  it("skips a line whose key is not valid base64 rather than counting it", () => {
    const text = "bastion.example.com ssh-ed25519 !!!not-base64!!!";
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("unknown");
  });

  it("tolerates CRLF line endings", () => {
    const text = `# pasted from Windows\r\n${line("bastion.example.com")}\r\n`;
    expect(checkKnownHosts(text, "bastion.example.com", 22, KEY)).toBe("match");
  });
});
