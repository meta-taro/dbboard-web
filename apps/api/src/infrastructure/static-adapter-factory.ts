import { CapabilityError } from "../domain/errors";
import type { AdapterConfig, AdapterFactory } from "../usecase/adapter-factory.port";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NullAdapter } from "./null-adapter";
import { createD1Adapter, D1Adapter } from "./d1-adapter";
import { createPostgresAdapter, PostgresAdapter } from "./postgres-adapter";
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
 * reach a database first — `postgres`, `turso`, then `d1` — and `null` last
 * because it connects to nothing.
 */
interface DriverBuilder {
  create(config: AdapterConfig): DatabaseAdapter;
  // How this driver re-points an existing connection. Split from `create`
  // because only the driver knows what an edit may leave unsaid: postgres
  // keeps the password the old pool holds, and a driver with no credential
  // has nothing to keep (0027 slice G).
  rebuild(previous: DatabaseAdapter, config: AdapterConfig): DatabaseAdapter;
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
  ["null", { create: () => new NullAdapter(), rebuild: () => new NullAdapter() }],
]);

// Each driver-branch validates the shape of `config` it needs; the factory
// itself stays oblivious. An unknown driver raises CapabilityError so
// POST /connections lands as 404 rather than a hard 500.
export class StaticAdapterFactory implements AdapterFactory {
  create(driver: string, config: AdapterConfig): DatabaseAdapter {
    return this.builderFor(driver).create(config);
  }

  rebuild(previous: DatabaseAdapter, driver: string, config: AdapterConfig): DatabaseAdapter {
    return this.builderFor(driver).rebuild(previous, config);
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
