import { describe, expect, it } from "vitest";
import { CapabilityError } from "../errors";
import { sshPartsOf } from "./ssh-parts";

// The literal the tunnel specs use: the resolver checks that a private key is
// key material and not a path, so the fixture has to look like one. Exactly
// the shape `scripts/pii-scan.allow` allows, body and all.
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

describe("sshPartsOf", () => {
  it("describes no tunnel when the config names none", () => {
    expect(sshPartsOf(undefined)).toBeUndefined();
  });

  it("reports where the bastion is and who it connects as", () => {
    const parts = sshPartsOf({
      host: "bastion.example.com",
      port: 2222,
      user: "deploy",
      privateKey: KEY,
      fingerprint: "SHA256:abc",
    });

    expect(parts).toEqual({
      host: "bastion.example.com",
      port: 2222,
      user: "deploy",
      auth: "private-key",
      hostKey: { kind: "fingerprint", fingerprint: "SHA256:abc" },
    });
  });

  it("names which credential the tunnel uses without carrying it", () => {
    const parts = sshPartsOf({
      host: "bastion.example.com",
      user: "deploy",
      privateKey: KEY,
      passphrase: "s3cret",
      fingerprint: "SHA256:abc",
    });

    expect(parts?.auth).toBe("private-key");
    // The whole point of the type: a prefill built from it cannot leak the
    // key or its passphrase, because there is nowhere to put them.
    expect(JSON.stringify(parts)).not.toContain("OPENSSH");
    expect(JSON.stringify(parts)).not.toContain("s3cret");
  });

  it("reports password auth the same way, and keeps the password out", () => {
    const parts = sshPartsOf({
      host: "bastion.example.com",
      user: "deploy",
      password: "hunter2",
      fingerprint: "SHA256:abc",
    });

    expect(parts?.auth).toBe("password");
    expect(JSON.stringify(parts)).not.toContain("hunter2");
  });

  it("reports the port the tunnel actually uses, not the one the form left blank", () => {
    const parts = sshPartsOf({
      host: "bastion.example.com",
      user: "deploy",
      password: "hunter2",
      fingerprint: "SHA256:abc",
    });

    // A form prefilled with a blank port would look like a different tunnel
    // from the one running.
    expect(parts?.port).toBe(22);
  });

  it("carries a known-hosts policy through as itself", () => {
    const knownHosts = "bastion.example.com ssh-ed25519 AAAAC3Nz";
    const parts = sshPartsOf({
      host: "bastion.example.com",
      user: "deploy",
      password: "hunter2",
      knownHosts,
    });

    expect(parts?.hostKey).toEqual({ kind: "known-hosts", knownHosts });
  });

  it("refuses to describe a tunnel the resolver would not open", () => {
    // No host key. Describing this as a tunnel would put a row in the sidebar
    // for a connection that cannot exist.
    expect(() =>
      sshPartsOf({ host: "bastion.example.com", user: "deploy", password: "hunter2" }),
    ).toThrow(CapabilityError);
  });
});
