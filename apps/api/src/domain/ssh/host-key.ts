import { fingerprintMatches, sha256Fingerprint } from "./fingerprint";
import { checkKnownHosts, knownHostsName } from "./known-hosts";

/**
 * How a tunnel decides whether to trust the key the bastion presents.
 *
 * Two verifying modes and no third. ADR-0069 Decision 2: "host-key
 * verification is mandatory; blind-accept is not an option in the type" —
 * so there is no `AcceptAny` variant to reach for under deadline pressure,
 * and `resolveSshTunnelConfig` refuses a config that names neither.
 */
export type HostKeyPolicy =
  | { readonly kind: "fingerprint"; readonly fingerprint: string }
  | { readonly kind: "known-hosts"; readonly knownHosts: string };

export interface HostKeyVerdict {
  readonly accepted: boolean;
  /** Why it was refused, in the operator's terms. Absent on acceptance. */
  readonly reason?: string;
}

const ACCEPTED: HostKeyVerdict = { accepted: true };

/**
 * Check a presented host key against the policy.
 *
 * The refusal messages are the desktop tunnel's, word for word
 * (`crates/dbboard-tunnel/src/tunnel.rs`), because they are the part an
 * operator acts on: "unknown host, pin it" and "the key changed" call for
 * opposite responses, and a shared "connection failed" would hide the
 * difference — which is exactly what `TunnelError::HostKey` exists to
 * prevent.
 */
export function verifyHostKey(
  policy: HostKeyPolicy,
  host: string,
  port: number,
  hostKey: Uint8Array,
): HostKeyVerdict {
  if (policy.kind === "fingerprint") {
    const presented = sha256Fingerprint(hostKey);
    if (fingerprintMatches(policy.fingerprint, presented)) return ACCEPTED;
    return {
      accepted: false,
      reason: `host key fingerprint mismatch: expected ${policy.fingerprint.trim()}, server presented ${presented}`,
    };
  }

  const name = knownHostsName(host, port);
  switch (checkKnownHosts(policy.knownHosts, host, port, hostKey)) {
    case "match":
      return ACCEPTED;
    case "unknown":
      return {
        accepted: false,
        reason: `unknown host ${name}; pin it before connecting`,
      };
    case "mismatch":
      return {
        accepted: false,
        reason: `KEY MISMATCH for ${name} — the host key changed, possible man-in-the-middle`,
      };
  }
}
