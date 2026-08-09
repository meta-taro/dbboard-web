import { CapabilityError } from "../domain/errors";
import {
  DEFAULT_MYSQL_PORT,
  DEFAULT_POSTGRES_PORT,
  forwardTarget,
  graftSshTunnel,
  redirectToLoopback,
  type ForwardTarget,
  type SshEdit,
  type SshParts,
  type SshTunnelConfig,
} from "../domain/ssh";
import type { AdapterConfig, AdapterFactory } from "../usecase/adapter-factory.port";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NullAdapter } from "./null-adapter";
import { createD1Adapter, D1Adapter } from "./d1-adapter";
import { createMySqlAdapter, MySqlAdapter } from "./mysql-adapter";
import { createPostgresAdapter, PostgresAdapter } from "./postgres-adapter";
import { openSshTunnel, type SshTunnelHandle } from "./ssh-tunnel";
import { isTunneledAdapter, openTunneledAdapter } from "./tunneled-adapter";
import { createTursoAdapter, TursoAdapter } from "./turso-adapter";

/**
 * The drivers this build can construct, and how.
 *
 * A `Map` rather than an object literal or a `switch`. Over an object, it is
 * the prototype: `driver` arrives from the request body, so `BUILDERS["constructor"]`
 * on a plain object finds a function and the factory would call it. Over a
 * `switch`, it is that the keys are enumerable — `supported()` reads the same
 * table `create` dispatches on, so the two cannot report different sets.
 *
 * Insertion order is display order (Maps preserve it): the drivers that
 * reach a database first — `postgres`, `turso`, `d1`, then `mysql` — and
 * `null` last because it connects to nothing.
 */
interface DriverBuilder {
  create(config: AdapterConfig): DatabaseAdapter;
  // How this driver re-points an existing connection. Split from `create`
  // because only the driver knows what an edit may leave unsaid: postgres
  // keeps the password the old pool holds, and a driver with no credential
  // has nothing to keep (0027 slice G).
  rebuild(previous: DatabaseAdapter, config: AdapterConfig): DatabaseAdapter;
  /**
   * Where to forward to when the connection names no port, and — by being
   * set at all — that this driver can be fronted by an SSH tunnel (0031
   * slice D).
   *
   * One field rather than a `supportsSsh` flag beside a port, because the
   * two can only be wrong separately: a forward redirects a TCP `host:port`
   * pair, so a driver that cannot say which port it speaks on has nothing to
   * redirect. Turso is a libSQL URL, D1 is an HTTPS API, and `null` connects
   * to nothing; desktop reaches the same set structurally, by hanging `ssh`
   * off the URL-bearing `BackendConfig` variants only, and refuses the rest
   * in `ConnectionKind::supports_ssh_tunnel`.
   */
  defaultPort?: number;
}

/** How a forward is opened. Injected so the factory can be tested without a bastion. */
export interface StaticAdapterFactoryDeps {
  openTunnel?: (config: SshTunnelConfig, target: ForwardTarget) => Promise<SshTunnelHandle>;
}

const BUILDERS = new Map<string, DriverBuilder>([
  [
    "postgres",
    {
      create: (config) => createPostgresAdapter(config),
      // Asked of the adapter, not performed on it. The factory never sees
      // the credential — `rebuildWith` moves it from one private pool to
      // the next and answers with an adapter.
      //
      // The guard is for the compiler, and unreachable in practice: a
      // record's driver is the one its adapter was built from. Falling back
      // to a plain create is the honest reading of "no previous postgres
      // pool to carry anything from".
      rebuild: (previous, config) =>
        previous instanceof PostgresAdapter
          ? previous.rebuildWith(config)
          : createPostgresAdapter(config),
      defaultPort: DEFAULT_POSTGRES_PORT,
    },
  ],
  [
    "turso",
    {
      create: (config) => createTursoAdapter(config),
      // Same shape as postgres, and for the same reason: the credential —
      // here a bearer token rather than a password — lives only inside the
      // adapter, so the successor has to be asked of it.
      rebuild: (previous, config) =>
        previous instanceof TursoAdapter
          ? previous.rebuildWith(config)
          : createTursoAdapter(config),
    },
  ],
  [
    "d1",
    {
      create: (config) => createD1Adapter(config),
      // Same shape again. D1's credential is a Cloudflare API token, and
      // it reaches the successor the same way the other two do — from one
      // private field to the next, never through the factory.
      rebuild: (previous, config) =>
        previous instanceof D1Adapter ? previous.rebuildWith(config) : createD1Adapter(config),
    },
  ],
  [
    "mysql",
    {
      create: (config) => createMySqlAdapter(config),
      // Same shape as postgres, and literally the same credential: a
      // password embedded in a URL the browser is never shown (ADR-0080).
      rebuild: (previous, config) =>
        previous instanceof MySqlAdapter
          ? previous.rebuildWith(config)
          : createMySqlAdapter(config),
      defaultPort: DEFAULT_MYSQL_PORT,
    },
  ],
  ["null", { create: () => new NullAdapter(), rebuild: () => new NullAdapter() }],
]);

// Each driver-branch validates the shape of `config` it needs; the factory
// itself stays oblivious. An unknown driver raises CapabilityError so
// POST /connections lands as 404 rather than a hard 500.
export class StaticAdapterFactory implements AdapterFactory {
  private readonly openTunnel: NonNullable<StaticAdapterFactoryDeps["openTunnel"]>;

  constructor(deps: StaticAdapterFactoryDeps = {}) {
    this.openTunnel = deps.openTunnel ?? openSshTunnel;
  }

  async create(driver: string, config: AdapterConfig): Promise<DatabaseAdapter> {
    const builder = this.builderFor(driver);
    // Nothing is running yet, so there is nothing to keep: `graftSshTunnel`
    // with no previous config reads an absent block and an explicit `null`
    // alike, as "connect directly".
    return this.build(
      driver,
      builder,
      config,
      (cfg) => builder.create(cfg),
      (edit) => graftSshTunnel(undefined, edit),
    );
  }

  /**
   * The tunnel a connection is running over, or `undefined` for a direct one.
   *
   * The registry stores this rather than deriving it from the request that
   * created the connection, because after an edit the two differ: a form that
   * left the credential box blank describes a tunnel with no way in, and the
   * one actually running has the credential it carried over.
   */
  describeTunnel(adapter: DatabaseAdapter): SshParts | undefined {
    return isTunneledAdapter(adapter) ? adapter.describeTunnel() : undefined;
  }

  async rebuild(
    previous: DatabaseAdapter,
    driver: string,
    config: AdapterConfig,
  ): Promise<DatabaseAdapter> {
    const builder = this.builderFor(driver);
    // Through the wrapper to the driver underneath. A `TunneledAdapter` is
    // not a `PostgresAdapter`, so handing it straight to `rebuild` would miss
    // every `instanceof` above and fall back to a fresh, credential-less
    // adapter — an edit that left the password blank would silently lose it.
    // The old wrapper is not closed here: UpdateConnection does that after
    // the replacement is live, and closing it takes the old forward with it.
    const inner = isTunneledAdapter(previous) ? previous.unwrap() : previous;
    // The bastion credential carries the same way and for the same reason,
    // one layer out: it lives in the wrapper, so the wrapper is what an edit
    // has to be applied to (0031 slice F2).
    return this.build(
      driver,
      builder,
      config,
      (cfg) => builder.rebuild(inner, cfg),
      isTunneledAdapter(previous)
        ? (edit) => previous.carryTunnel(edit)
        : (edit) => graftSshTunnel(undefined, edit),
    );
  }

  /**
   * The one path both entry points take: strip the `ssh` block off the
   * config, and either build the driver directly or build it against a
   * freshly opened forward.
   *
   * `make` receives a config the driver can read — never the `ssh` block,
   * which is not a driver setting, and with `host`/`port` already pointed at
   * loopback when there is a tunnel. `carry` answers what the `ssh` block
   * means for *this* connection, which only its predecessor knows: the same
   * absent block means "no tunnel" on the way in and "the tunnel you have"
   * on the way through an edit.
   */
  private async build(
    driver: string,
    builder: DriverBuilder,
    config: AdapterConfig,
    make: (config: AdapterConfig) => DatabaseAdapter,
    carry: (edit: SshEdit) => SshTunnelConfig | undefined,
  ): Promise<DatabaseAdapter> {
    const { ssh, ...rest } = config;
    const tunnel = carry(ssh);
    if (tunnel === undefined) return make(rest);

    if (builder.defaultPort === undefined) {
      // Desktop raises `ConfigError::SshUnsupportedKind` here rather than
      // ignoring the block: a tunnel that was configured and silently not
      // used is a connection the operator believes is private and is not.
      throw new CapabilityError(`driver does not support an ssh tunnel: ${driver}`);
    }

    // Both resolve before anything is dialled, so a malformed tunnel config
    // or a connection that names no host costs no round trip. (`carry` did
    // the tunnel half above — a block the resolver refuses has already thrown
    // by this point.)
    const target = forwardTarget(rest, builder.defaultPort);

    return openTunneledAdapter({
      tunnel,
      openTunnel: (config) => this.openTunnel(config, target),
      // Re-run on every reconnect, against the new forward's port — which is
      // why it closes over `rest` rather than over a resolved config.
      buildInner: (localPort) => make(redirectToLoopback(rest, localPort)),
    });
  }

  private builderFor(driver: string): DriverBuilder {
    const builder = BUILDERS.get(driver);
    if (builder === undefined) throw new CapabilityError(`unknown driver: ${driver}`);
    return builder;
  }

  supported(): readonly string[] {
    // A fresh array each call: the caller receives it across a use case and
    // out of an HTTP handler, and neither should be able to edit the set of
    // drivers this process can build.
    return [...BUILDERS.keys()];
  }
}
