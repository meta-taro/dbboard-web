import type { HostKeyPolicy } from "./host-key";
import type { SshAuth } from "./tunnel-config";

/** Which credential the tunnel authenticates with — not the credential. */
export type SshAuthKind = SshAuth["kind"];

/**
 * The half of an SSH tunnel that is safe to remember: where the bastion is,
 * who it connects as, which kind of credential it uses, and how its host key
 * is checked.
 *
 * The ssh counterpart of `ConnectionParts`, and it exists for the same reason
 * (desktop ADR-0080): an edit form has to be able to show the tunnel a
 * connection is running over, and the process holding the key cannot answer
 * "what is this tunnel" by handing over the key. Naming the non-secret parts
 * separately is the way out — **a prefill built from this type cannot leak
 * the key or the bastion password by oversight, because there is nowhere to
 * put them.**
 *
 * Every member is required, unlike `ConnectionParts`. A half-known tunnel is
 * not a thing: `resolveSshTunnelConfig` refuses a config missing any of these,
 * so a tunnel that is running has all of them.
 *
 * Desktop's equivalent is `SshPrefill` in `lib/connections/draft.ts`, with the
 * divergence the whole ssh port carries: desktop prefills a key *path* and an
 * `encrypted` flag, because the path is not itself a secret. Web takes key
 * *material*, so there is no non-secret half of the credential to prefill and
 * no flag to carry — `auth` says which box to show, and the box starts empty.
 */
export interface SshParts {
  host: string;
  port: number;
  user: string;
  auth: SshAuthKind;
  hostKey: HostKeyPolicy;
}

/**
 * What the projection below reads. Structurally a supertype of
 * `SshTunnelConfig`, so a resolved config passes straight in — but declared
 * narrowly on purpose, exactly as `ConnectionPartsSource` is: `auth` is typed
 * down to its discriminant, so the body **cannot** read the private key or the
 * password off it. The guarantee is in the parameter type, not in the care
 * taken while writing the body.
 */
interface SshPartsSource {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly auth: { readonly kind: SshAuthKind };
  readonly hostKey: HostKeyPolicy;
}

/**
 * Describe a tunnel that is running.
 *
 * Takes a resolved config rather than a request body on purpose (0031 slice
 * F2). What the sidebar should show is what the forward actually does, and
 * those differ: a blank port is 22 by the time it is dialled, and an edit that
 * left the credential box empty is running on the credential it carried over,
 * which no request body says. Describing the input would have described a
 * connection nobody made.
 */
export function sshPartsOf(source: SshPartsSource): SshParts {
  return {
    host: source.host,
    port: source.port,
    user: source.user,
    auth: source.auth.kind,
    hostKey: source.hostKey,
  };
}
