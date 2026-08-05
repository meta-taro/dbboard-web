import { CapabilityError } from "../domain/errors";
import type { AdapterConfig, AdapterFactory } from "../usecase/adapter-factory.port";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { NullAdapter } from "./null-adapter";
import { createPostgresAdapter } from "./postgres-adapter";

/**
 * The drivers this build can construct, and how.
 *
 * A `Map` rather than an object literal or a `switch`. Over an object, it is
 * the prototype: `driver` arrives from the request body, so `BUILDERS["constructor"]`
 * on a plain object finds a function and the factory would call it. Over a
 * `switch`, it is that the keys are enumerable — `supported()` reads the same
 * table `create` dispatches on, so the two cannot report different sets.
 *
 * Insertion order is display order (Maps preserve it): `postgres` first
 * because it is the driver anyone actually connects with, `null` last
 * because it connects to nothing.
 */
const BUILDERS = new Map<string, (config: AdapterConfig) => DatabaseAdapter>([
  ["postgres", (config) => createPostgresAdapter(config)],
  ["null", () => new NullAdapter()],
]);

// Each driver-branch validates the shape of `config` it needs; the factory
// itself stays oblivious. An unknown driver raises CapabilityError so
// POST /connections lands as 404 rather than a hard 500.
export class StaticAdapterFactory implements AdapterFactory {
  create(driver: string, config: AdapterConfig): DatabaseAdapter {
    const build = BUILDERS.get(driver);
    if (build === undefined) throw new CapabilityError(`unknown driver: ${driver}`);
    return build(config);
  }

  supported(): readonly string[] {
    // A fresh array each call: the caller receives it across a use case and
    // out of an HTTP handler, and neither should be able to edit the set of
    // drivers this process can build.
    return [...BUILDERS.keys()];
  }
}
