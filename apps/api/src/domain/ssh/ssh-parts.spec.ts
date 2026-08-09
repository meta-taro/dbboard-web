import { describe, expect, it } from "vitest";
import { sshPartsOf } from "./ssh-parts";
import { resolveSshTunnelConfig } from "./tunnel-config";

// The literal the tunnel specs use: the resolver checks that a private key is
// key material and not a path, so the fixture has to look like one. Exactly
// the shape `scripts/pii-scan.allow` allows, body and all.
const KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

// Every case resolves first and projects second, because that is the order the
// running code uses and the two halves are only correct together: the resolver
// decides what the tunnel does, and this decides how much of that is safe to
// remember.
const partsOf = (input: Record<string, unknown>) => sshPartsOf(resolveSshTunnelConfig(input));

describe("sshPartsOf", () => {
  it("reports where the bastion is and who it connects as", () => {
    expect(
      partsOf({
        host: "bastion.example.com",
        port: 2222,
        user: "deploy",
        privateKey: KEY,
        fingerprint: "SHA256:abc",
      }),
    ).toEqual({
      host: "bastion.example.com",
      port: 2222,
      user: "deploy",
      auth: "private-key",
      hostKey: { kind: "fingerprint", fingerprint: "SHA256:abc" },
    });
  });

  it("names which credential the tunnel uses without carrying it", () => {
    const parts = partsOf({
      host: "bastion.example.com",
      user: "deploy",
      privateKey: KEY,
      passphrase: "s3cret",
      fingerprint: "SHA256:abc",
    });

    expect(parts.auth).toBe("private-key");
    // The whole point of the type: a prefill built from it cannot leak the
    // key or its passphrase, because there is nowhere to put them.
    expect(JSON.stringify(parts)).not.toContain("OPENSSH");
    expect(JSON.stringify(parts)).not.toContain("s3cret");
  });

  it("reports password auth the same way, and keeps the password out", () => {
    const parts = partsOf({
      host: "bastion.example.com",
      user: "deploy",
      password: "hunter2",
      fingerprint: "SHA256:abc",
    });

    expect(parts.auth).toBe("password");
    expect(JSON.stringify(parts)).not.toContain("hunter2");
  });

  it("reports the port the tunnel actually uses, not the one the form left blank", () => {
    // A form prefilled with a blank port would look like a different tunnel
    // from the one running. Projecting the resolved config rather than the
    // request body is what makes this true without restating the default.
    expect(
      partsOf({
        host: "bastion.example.com",
        user: "deploy",
        password: "hunter2",
        fingerprint: "SHA256:abc",
      }).port,
    ).toBe(22);
  });

  it("carries a known-hosts policy through as itself", () => {
    const knownHosts = "bastion.example.com ssh-ed25519 AAAAC3Nz";
    const parts = partsOf({
      host: "bastion.example.com",
      user: "deploy",
      password: "x",
      knownHosts,
    });

    expect(parts.hostKey).toEqual({ kind: "known-hosts", knownHosts });
  });
});
