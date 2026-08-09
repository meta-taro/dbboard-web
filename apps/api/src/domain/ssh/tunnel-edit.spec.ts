import { describe, expect, it } from "vitest";

import { CapabilityError } from "../errors";
import type { SshTunnelConfig } from "./tunnel-config";
import { graftSshTunnel } from "./tunnel-edit";

const RUNNING: SshTunnelConfig = {
  host: "bastion.example.com",
  port: 22,
  user: "deploy",
  auth: { kind: "password", password: "s3cret" },
  hostKey: { kind: "fingerprint", fingerprint: "SHA256:abc123" },
};

describe("graftSshTunnel", () => {
  it("keeps the tunnel when the edit says nothing about it", () => {
    // Desktop's `SshEditInput::Keep`, which is the default arm there because
    // a PATCH body says what changed. An absent block read as "no tunnel"
    // would take a connection off its bastion for a renamed label.
    expect(graftSshTunnel(RUNNING, undefined)).toBe(RUNNING);
  });

  it("takes the tunnel away when the edit is an explicit null", () => {
    // `SshEditInput::Disable`. There has to be a way to say it, and with
    // absence meaning keep, the only spelling left is one the operator has
    // to write on purpose.
    expect(graftSshTunnel(RUNNING, null)).toBeUndefined();
  });

  it("replaces the tunnel when the edit describes one", () => {
    const grafted = graftSshTunnel(RUNNING, {
      host: "bastion-2.example.com",
      port: 2222,
      user: "release",
      password: "other",
      fingerprint: "SHA256:def456",
    });

    expect(grafted).toEqual({
      host: "bastion-2.example.com",
      port: 2222,
      user: "release",
      auth: { kind: "password", password: "other" },
      hostKey: { kind: "fingerprint", fingerprint: "SHA256:def456" },
    });
  });

  it("carries the credential into an edit that leaves the secret box blank", () => {
    // The reason this function exists rather than a bare
    // `resolveSshTunnelConfig` at each call site: the form cannot prefill a
    // password box, so every saved edit re-submits it empty, and the running
    // tunnel is the only place the password still is (ADR-0080).
    const grafted = graftSshTunnel(RUNNING, {
      host: "bastion.example.com",
      port: 2222,
      user: "deploy",
      password: "",
      fingerprint: "SHA256:abc123",
    });

    expect(grafted?.auth).toEqual({ kind: "password", password: "s3cret" });
    expect(grafted?.port).toBe(2222);
  });

  it("has nothing to carry into a first tunnel, and says so", () => {
    // Registration takes the same path with no previous config. A blank
    // credential here is not a carry — it is a tunnel with no way in.
    expect(() =>
      graftSshTunnel(undefined, { host: "bastion.example.com", user: "deploy", fingerprint: "x" }),
    ).toThrowError(CapabilityError);
  });

  it("leaves a direct connection direct when the edit says nothing", () => {
    expect(graftSshTunnel(undefined, undefined)).toBeUndefined();
  });

  it("still requires a host key from an edit that keeps the credential", () => {
    // The host key is not a secret, so the form can and does prefill it —
    // which means an edit arriving without one is an edit that cleared it,
    // and a bastion with no way to verify it is the blind-accept case
    // ADR-0069 refuses to have. Carrying it over would reinstate that case
    // by the back door.
    expect(() =>
      graftSshTunnel(RUNNING, { host: "bastion.example.com", user: "deploy", password: "" }),
    ).toThrowError(CapabilityError);
  });
});
