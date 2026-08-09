import { resolveSshTunnelConfig, type SshTunnelConfig, type SshTunnelInput } from "./tunnel-config";

/**
 * What an edit can say about the tunnel in front of a connection.
 *
 * Three states, mirroring desktop's `SshEditInput` (`src-tauri/src/lib.rs`,
 * read at `main` = b98f7a6):
 *
 * - **absent** — `Keep`. The edit is about something else; leave the tunnel
 *   exactly as it is, credential included.
 * - **`null`** — `Disable`. Take the bastion away and connect directly.
 * - **an object** — `Set`. Use this tunnel, with blank secret boxes reading
 *   as "the one you already have" (ADR-0080).
 *
 * The alternative — absence meaning "no tunnel" — is what this replaces, and
 * it is wrong in the direction that matters: a PATCH body says what changed,
 * so renaming a connection would have taken it off its bastion and connected
 * straight to the database the operator was tunnelling to reach. Disabling a
 * tunnel is rare and deliberate, so it is the one that has to be spelled out.
 */
export type SshEdit = SshTunnelInput | null | undefined;

/**
 * The tunnel a connection should run over after an edit, given the one it is
 * running over now.
 *
 * Registration passes `undefined` for `previous` and takes the same three
 * arms: with nothing running, `Keep` and `Disable` both mean "direct", and a
 * blank credential under `Set` has nothing to carry — so it is refused, which
 * is the honest answer for a bastion with no way in.
 *
 * `previous` carries a live credential, so nothing here may return it to a
 * caller that did not already have it. The two arms that could — `Keep` and a
 * carried `Set` — hand back a config the caller is about to dial, which is the
 * one thing a config is for; `SshParts` is what everything else gets.
 */
export function graftSshTunnel(
  previous: SshTunnelConfig | undefined,
  edit: SshEdit,
): SshTunnelConfig | undefined {
  if (edit === undefined) return previous;
  if (edit === null) return undefined;
  // Only the credential is carried. Host, port, user and host key are not
  // secrets, so the form renders them filled in and an edit that omits one is
  // an edit that cleared it — carrying those would make a cleared host key
  // unclearable, and an unverified bastion is exactly what ADR-0069 refuses.
  return resolveSshTunnelConfig(edit, previous?.auth);
}
