import { CapabilityError } from "../errors";
import type { HostKeyPolicy } from "./host-key";

/**
 * The SSH half of a connection, resolved out of whatever the request body
 * carried.
 *
 * Mirrors desktop `crates/dbboard-connect/src/ssh.rs` (`ResolvedSsh`), with
 * one deliberate divergence. Desktop takes *paths* — `SshAuth::PrivateKey {
 * path }` and `HostKeyPolicy::KnownHosts(Option<PathBuf>)` — because the
 * process reading them is the one the operator is sitting in front of. Here
 * the config arrives over HTTP, so a path field would let a caller make the
 * API process read arbitrary files off the server. Web therefore takes
 * *material*: the key text and the `known_hosts` text. Same argument the
 * Turso adapter makes when it refuses `file:` URLs.
 */
export type SshAuth =
  | { readonly kind: "private-key"; readonly privateKey: string; readonly passphrase?: string }
  | { readonly kind: "password"; readonly password: string };

export interface SshTunnelConfig {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: SshAuth;
  readonly hostKey: HostKeyPolicy;
}

/**
 * The shape as it arrives — every field `unknown`, because it comes from a
 * request body.
 *
 * Unrecognised fields (`privateKeyPath`, say) are ignored rather than quietly
 * honoured, and that is a property of the resolver below, which reads these
 * eight names and nothing else. It is deliberately *not* expressed as an
 * index signature: a class can never satisfy one — TypeScript grants implicit
 * index signatures to object literal types only — and the shape that actually
 * arrives over HTTP is a class, `SshTunnelDto`. Declaring the tolerance in the
 * type bought nothing the resolver did not already provide and cost the one
 * assignment that has to hold.
 */
export interface SshTunnelInput {
  readonly host?: unknown;
  readonly port?: unknown;
  readonly user?: unknown;
  readonly privateKey?: unknown;
  readonly passphrase?: unknown;
  readonly password?: unknown;
  readonly fingerprint?: unknown;
  readonly knownHosts?: unknown;
}

export const DEFAULT_SSH_PORT = 22;

function requiredText(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CapabilityError(`ssh tunnel requires ${field}`);
  }
  return value.trim();
}

function optionalText(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value === "") return undefined;
  return value;
}

function resolvePort(value: unknown): number {
  if (value === undefined || value === null || value === "") return DEFAULT_SSH_PORT;
  // A form sends numbers as strings; `Number` on a non-numeric string is NaN,
  // which fails the range check below rather than falling back to 22. A
  // silent fallback would connect somewhere the operator did not ask for.
  const port = typeof value === "string" ? Number(value) : value;
  if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new CapabilityError(
      `ssh tunnel port must be an integer in 1..65535, got: ${String(value)}`,
    );
  }
  return port;
}

function resolveAuth(input: SshTunnelInput, carried: SshAuth | undefined): SshAuth {
  const privateKey = optionalText(input.privateKey);
  const password = optionalText(input.password);

  // ADR-0080's rule, reaching the bastion. A secret box cannot be prefilled,
  // so an edit form re-submits it blank, and a blank box says "the one you
  // have" rather than "none". Only when *both* are blank, though: a caller
  // sending two credentials is ambiguous whether or not one is stored.
  if (carried !== undefined && privateKey === undefined && password === undefined) {
    return carried;
  }

  if ((privateKey === undefined) === (password === undefined)) {
    throw new CapabilityError(
      "ssh tunnel requires exactly one of privateKey or password (privateKey is the key text, not a path)",
    );
  }

  if (privateKey !== undefined) {
    if (!/-----BEGIN [^-]*PRIVATE KEY-----/.test(privateKey)) {
      throw new CapabilityError(
        "ssh tunnel privateKey must be PEM key material, not a path or a key name",
      );
    }
    const passphrase = optionalText(input.passphrase);
    return passphrase === undefined
      ? { kind: "private-key", privateKey }
      : { kind: "private-key", privateKey, passphrase };
  }

  return { kind: "password", password: password as string };
}

function resolveHostKey(input: SshTunnelInput): HostKeyPolicy {
  const fingerprint = optionalText(input.fingerprint);
  const knownHosts = optionalText(input.knownHosts);

  // Neither is the blind-accept case ADR-0069 refuses to have. Both is
  // ambiguous about which one actually decided, and an operator reading a
  // refusal needs to know which.
  if ((fingerprint === undefined) === (knownHosts === undefined)) {
    throw new CapabilityError("ssh tunnel requires exactly one of fingerprint or knownHosts");
  }

  return fingerprint !== undefined
    ? { kind: "fingerprint", fingerprint }
    : { kind: "known-hosts", knownHosts: knownHosts as string };
}

/**
 * Resolve a tunnel out of a request body.
 *
 * `carriedAuth` is the credential the connection is already using, if any. It
 * is what makes an *edit* possible: the form cannot prefill a secret box, so a
 * saved edit re-submits it blank, and without something to carry that blank
 * would tear down a working tunnel over a port change. Registration passes
 * nothing and the rule below is unreachable, which is right — there is no
 * stored credential to mean.
 *
 * Everything else is resolved the same way either time. Host, port, user and
 * host key are not secrets, so a form can render them, and an edit that omits
 * one is an edit that removed it.
 */
export function resolveSshTunnelConfig(
  input: SshTunnelInput,
  carriedAuth?: SshAuth,
): SshTunnelConfig {
  return {
    host: requiredText(input.host, "host"),
    port: resolvePort(input.port),
    user: requiredText(input.user, "user"),
    auth: resolveAuth(input, carriedAuth),
    hostKey: resolveHostKey(input),
  };
}

/**
 * A one-line rendering safe to put in a log or an error.
 *
 * Desktop gets this from a hand-written `Debug` that prints `<redacted>`;
 * TypeScript has no such hook, so anything that wants to name a tunnel has
 * to call this instead of interpolating the config. What is safe to show is
 * the endpoint and the *kind* of each secret — never the secret, and never
 * the pinned fingerprint's body either, since it identifies the host.
 */
export function describeSshTunnel(config: SshTunnelConfig): string {
  return `${config.user}@${config.host}:${config.port} (auth: ${config.auth.kind}, host key: ${config.hostKey.kind})`;
}
