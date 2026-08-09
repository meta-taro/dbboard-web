import type { DatabaseAdapter } from "../domain/database-adapter.port";
import type { SshEdit, SshParts } from "../domain/ssh";
import type { SslMode } from "../domain/ssl-mode";

// Open bag of driver-config fields. The "null" branch ignores everything;
// the "postgres" branch (0004) reads the connection bits. Keeping this
// open (vs. a discriminated union) lets the factory stay driver-agnostic
// — each branch picks what it needs and validates the shape.
export interface AdapterConfig {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  // 0027 slice B. Typed rather than `string` so a driver that later grows
  // its own TLS handling inherits the two-mode vocabulary instead of
  // inventing a third spelling of the same choice.
  sslMode?: SslMode;
  // 0031 slice A. Turso authenticates with a bearer token rather than with
  // a user/password pair, and the token is not part of the URL. A field of
  // its own rather than a reuse of `password`, because the two are not the
  // same field wearing different labels: `password` is half of a credential
  // pair the postgres branch resolves alongside `user`, and a form that
  // labelled a Turso token "password" would be lying about what to paste
  // in. It carries forward across an edit the way `password` does
  // (ADR-0080) — see `TursoAdapter.rebuildWith`. 0031 slice B reuses it for
  // Cloudflare D1's API token: genuinely the same slot, a bearer credential
  // that is not part of any URL, so a second field would be the same thing
  // under a second name.
  authToken?: string;
  // 0031 slice B. D1 addresses a database by two ids in the REST path
  // rather than by a host and a database name, and they are not
  // interchangeable with `database`: a caller who typed a D1 database id
  // into a box labelled "database" would have configured nothing. Named
  // after desktop's `D1Config` fields for the same reason `authToken` is
  // its own field — the form has to be able to say what to paste in.
  accountId?: string;
  databaseId?: string;
  // 0031 slice D (desktop ADR-0069). The bastion to reach this database
  // through, or absent for a direct connection. `unknown`-typed fields
  // throughout, because it arrives as a nested object in a request body and
  // `resolveSshTunnelConfig` is what turns it into something trustworthy.
  //
  // Not every driver can be fronted by one: a forward redirects a TCP
  // `host:port`, and Turso and D1 have no such pair to redirect. Desktop
  // makes that structural — `ssh` is a field on the URL-bearing
  // `BackendConfig` variants only — where an open config bag cannot, so the
  // factory refuses the pairing instead (`ConnectionKind::supports_ssh_tunnel`).
  //
  // Three states, not two (0031 slice F2, desktop `SshEditInput`): absent
  // keeps whatever the connection is already running over, `null` takes the
  // bastion away, and a block replaces it. See `SshEdit`.
  ssh?: SshEdit;
}

// Constructs an adapter from a driver discriminator + per-driver config.
// RegisterConnection calls this; the use case stays driver-agnostic.
// 0003 supplied a StaticAdapterFactory that only knew "null"; 0004 adds
// "postgres". An unknown driver raises CapabilityError so the
// `POST /connections` route 404s rather than hard-erroring.
//
// Asynchronous since 0031 slice D: a connection fronted by an SSH tunnel
// cannot be built until the forward is up and has told us its loopback port.
// The drivers themselves stay lazy — no `await` here opens a database socket
// — so a direct connection resolves without a round trip.
export interface AdapterFactory {
  create(driver: string, config: AdapterConfig): Promise<DatabaseAdapter>;

  // A replacement for `previous`, pointed at `config`. Separate from
  // `create` because of what an edit is allowed to leave out: the password.
  // Web keeps no keyring, so the only copy of a live connection's credential
  // is inside the adapter serving it — a rebuild has to start from that
  // adapter to be able to keep it (0027 slice G, desktop ADR-0080).
  //
  // Driver-agnostic in the same way `create` is: each branch decides what
  // carrying over means, and a driver holding no credential simply builds a
  // new one. Raises the same CapabilityError for an unknown driver or a
  // config the driver refuses — before anything is torn down, so a rejected
  // edit leaves the connection it was editing intact.
  rebuild(
    previous: DatabaseAdapter,
    driver: string,
    config: AdapterConfig,
  ): Promise<DatabaseAdapter>;

  // What tunnel, if any, an adapter this factory built is running over —
  // projected to the half that is safe to store and show (0031 slice F2).
  //
  // Asked of the factory rather than derived from the config that built the
  // adapter, because after an edit those disagree: an edit that left the
  // credential box blank describes a tunnel with no way in, while the one
  // running carried the credential over. Only the adapter knows which.
  //
  // Optional so that a fake standing in for a driver with no tunnel support
  // need not implement it; absent reads the same as "no tunnel", which is the
  // right answer for every such factory.
  describeTunnel?(adapter: DatabaseAdapter): SshParts | undefined;

  // The drivers `create` accepts, in the order a chooser should offer them.
  // 0027 slice E: the connection form used to restate this list in its
  // template, which was right only by coincidence — a driver added here and
  // not there is unreachable, and one offered there and missing here is a
  // 404 on submit. Asking is cheaper than keeping two lists in step.
  supported(): readonly string[];
}

export const ADAPTER_FACTORY = Symbol("ADAPTER_FACTORY");
