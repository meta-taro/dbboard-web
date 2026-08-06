import { describe, expect, it } from "vitest";

import { CapabilityError } from "../errors";
import { describeSshTunnel, resolveSshTunnelConfig } from "./tunnel-config";

const KEY_MATERIAL = "-----BEGIN OPENSSH PRIVATE KEY-----\nAAAA\n-----END OPENSSH PRIVATE KEY-----";

function minimal(overrides: Record<string, unknown> = {}) {
  return {
    host: "bastion.example.com",
    user: "deploy",
    password: "s3cret",
    fingerprint: "SHA256:abc123",
    ...overrides,
  };
}

describe("resolveSshTunnelConfig", () => {
  it("resolves a password + fingerprint tunnel", () => {
    expect(resolveSshTunnelConfig(minimal())).toEqual({
      host: "bastion.example.com",
      port: 22,
      user: "deploy",
      auth: { kind: "password", password: "s3cret" },
      hostKey: { kind: "fingerprint", fingerprint: "SHA256:abc123" },
    });
  });

  it("resolves a private key + known_hosts tunnel", () => {
    const config = resolveSshTunnelConfig(
      minimal({
        password: undefined,
        fingerprint: undefined,
        privateKey: KEY_MATERIAL,
        passphrase: "unlock",
        knownHosts: "bastion.example.com ssh-ed25519 AAAA",
      }),
    );

    expect(config.auth).toEqual({
      kind: "private-key",
      privateKey: KEY_MATERIAL,
      passphrase: "unlock",
    });
    expect(config.hostKey).toEqual({
      kind: "known-hosts",
      knownHosts: "bastion.example.com ssh-ed25519 AAAA",
    });
  });

  it("leaves the passphrase off when there is none", () => {
    const config = resolveSshTunnelConfig(
      minimal({ password: undefined, privateKey: KEY_MATERIAL }),
    );
    expect(config.auth).toEqual({ kind: "private-key", privateKey: KEY_MATERIAL });
  });

  it("defaults the port to 22", () => {
    expect(resolveSshTunnelConfig(minimal()).port).toBe(22);
  });

  it("accepts an explicit port", () => {
    expect(resolveSshTunnelConfig(minimal({ port: 2222 })).port).toBe(2222);
  });

  it("accepts a port given as a string, as a form would send it", () => {
    expect(resolveSshTunnelConfig(minimal({ port: "2222" })).port).toBe(2222);
  });

  it.each([0, 65536, -1, 1.5, "not-a-number"])("rejects the port %p", (port) => {
    expect(() => resolveSshTunnelConfig(minimal({ port }))).toThrow(CapabilityError);
  });

  it.each(["host", "user"])("requires %s", (field) => {
    expect(() => resolveSshTunnelConfig(minimal({ [field]: undefined }))).toThrow(CapabilityError);
    expect(() => resolveSshTunnelConfig(minimal({ [field]: "   " }))).toThrow(CapabilityError);
  });

  it("requires exactly one authentication method", () => {
    expect(() =>
      resolveSshTunnelConfig(minimal({ password: undefined, privateKey: undefined })),
    ).toThrow(/exactly one/);
    expect(() => resolveSshTunnelConfig(minimal({ privateKey: KEY_MATERIAL }))).toThrow(
      /exactly one/,
    );
  });

  it("requires exactly one host-key policy", () => {
    // Neither is the blind-accept case ADR-0069 refuses to have; both is
    // ambiguous about which one actually decided.
    expect(() => resolveSshTunnelConfig(minimal({ fingerprint: undefined }))).toThrow(
      /exactly one/,
    );
    expect(() =>
      resolveSshTunnelConfig(minimal({ knownHosts: "bastion ssh-ed25519 AAAA" })),
    ).toThrow(/exactly one/);
  });

  it("does not accept a path to key material", () => {
    // Desktop reads `~/.ssh/id_ed25519` off the machine the user is sitting
    // at. Here the request arrives over HTTP, so a path field would let a
    // caller make the API process read arbitrary server files — the same
    // reason the Turso adapter refuses `file:` URLs.
    expect(() =>
      resolveSshTunnelConfig(
        minimal({ password: undefined, privateKeyPath: "/home/app/.ssh/id_ed25519" }),
      ),
    ).toThrow(/exactly one/);
  });

  it("rejects a private key that is not PEM-shaped", () => {
    expect(() =>
      resolveSshTunnelConfig(minimal({ password: undefined, privateKey: "id_ed25519" })),
    ).toThrow(CapabilityError);
  });
});

describe("describeSshTunnel", () => {
  it("names the endpoint and the kind of each secret, never the secret", () => {
    const config = resolveSshTunnelConfig(
      minimal({ port: 2222, password: undefined, privateKey: KEY_MATERIAL, passphrase: "unlock" }),
    );
    const described = describeSshTunnel(config);

    expect(described).toContain("deploy@bastion.example.com:2222");
    expect(described).toContain("private-key");
    expect(described).not.toContain(KEY_MATERIAL);
    expect(described).not.toContain("unlock");
    expect(described).not.toContain("AAAA");
  });

  it("does not leak a password", () => {
    const described = describeSshTunnel(resolveSshTunnelConfig(minimal()));

    expect(described).not.toContain("s3cret");
    expect(described).toContain("password");
  });
});
