import type { DatabaseAdapter } from "../domain/database-adapter.port";
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
  // (ADR-0080) — see `TursoAdapter.rebuildWith`.
  authToken?: string;
}

// Constructs an adapter from a driver discriminator + per-driver config.
// RegisterConnection calls this; the use case stays driver-agnostic.
// 0003 supplied a StaticAdapterFactory that only knew "null"; 0004 adds
// "postgres". An unknown driver raises CapabilityError so the
// `POST /connections` route 404s rather than hard-erroring.
export interface AdapterFactory {
  create(driver: string, config: AdapterConfig): DatabaseAdapter;

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
  rebuild(previous: DatabaseAdapter, driver: string, config: AdapterConfig): DatabaseAdapter;

  // The drivers `create` accepts, in the order a chooser should offer them.
  // 0027 slice E: the connection form used to restate this list in its
  // template, which was right only by coincidence — a driver added here and
  // not there is unreachable, and one offered there and missing here is a
  // 404 on submit. Asking is cheaper than keeping two lists in step.
  supported(): readonly string[];
}

export const ADAPTER_FACTORY = Symbol("ADAPTER_FACTORY");
