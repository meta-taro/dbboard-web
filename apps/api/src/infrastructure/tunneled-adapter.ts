/**
 * A database adapter that reaches its server through an SSH local forward,
 * and keeps that forward honest — the web answer to desktop's ADR-0069
 * (tunnel) and ADR-0092 (cached-connection liveness), read at `main` =
 * b98f7a6.
 *
 * The two ship together on purpose. Web's `InMemoryConnectionRegistry` hands
 * out a cached live adapter with no eviction on failure and no health check,
 * so the moment it grows a tunnel it inherits the wedge whole: the bastion
 * goes away, the loopback listener keeps accepting, and every query after
 * that hangs against a socket nobody is on the other end of. Shipping the
 * tunnel without the liveness check would be shipping a known bug.
 *
 * The check lives here rather than in the registry because web keeps no
 * keyring: the only copy of a live connection's credential is inside the
 * adapter serving it, so this is the only layer that can rebuild one. The
 * registry keeps handing out the same handle and never learns that the
 * connection underneath it was replaced.
 */
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, ConnectionError } from "../domain/errors";
import type { Capabilities, QueryResult, TableInfo, TableSchema } from "../domain/values";
import type { SshTunnelHandle } from "./ssh-tunnel";

/**
 * How long a connection may sit unused before the next caller pays for a
 * probe.
 *
 * Matches {@link KEEPALIVE_INTERVAL_MS}: below one keepalive interval the
 * session has just been confirmed alive by the driver and a probe would only
 * re-ask the question. Above it, the connection may have been reaped between
 * keepalives — or the whole session may have been torn down while this
 * process slept — and the caller would rather spend one round trip than a
 * timeout.
 */
export const HEALTH_CHECK_AFTER_IDLE_MS = 30_000;

/**
 * The probe.
 *
 * Desktop's port has `ping()`; web's has not, and adding one would mean
 * touching every adapter for a method only this file calls. `SELECT 1` is
 * the cheapest statement PostgreSQL and MySQL both answer, and it travels
 * the same path a real query would — which is the point, since what is being
 * tested is the forward, not the server.
 */
export const PROBE_SQL = "SELECT 1";

export interface TunneledAdapterDeps {
  /** Opens a forward. Called again, with the same config, on recovery. */
  openTunnel: () => Promise<SshTunnelHandle>;
  /**
   * Builds the adapter that talks to `127.0.0.1:localPort`.
   *
   * Called again on recovery with the *new* forward's port, so the closure
   * must hold the credential rather than a resolved connection string.
   */
  buildInner: (localPort: number) => Promise<DatabaseAdapter> | DatabaseAdapter;
  /** Injected so an idle window costs a test no wall time. */
  now?: () => number;
}

/**
 * The marker {@link isTunneledAdapter} reads.
 *
 * A brand rather than a duck-type check, because the question being asked —
 * "is there a forward under this adapter?" — must not be answerable by an
 * unrelated adapter that happens to grow a `reconnect` method.
 */
export const TUNNELED_ADAPTER: unique symbol = Symbol("dbboard.tunneled-adapter");

export interface TunneledAdapter extends DatabaseAdapter {
  readonly [TUNNELED_ADAPTER]: true;
  close(): Promise<void>;
  /** Tear the forward down and open a fresh one, without waiting to go idle. */
  reconnect(): Promise<void>;
  /**
   * The adapter underneath, for an edit that has to rebuild from it.
   *
   * Not a leak of the credential: what comes back is the same object the
   * registry would have held without a tunnel, and asking it for a successor
   * (`rebuildWith`) is how every driver carries a secret across an edit
   * already (ADR-0080). Without this, an edit to a tunneled connection would
   * fall through to a plain `create` and silently drop the password the form
   * left blank.
   */
  unwrap(): DatabaseAdapter;
}

export function isTunneledAdapter(adapter: DatabaseAdapter): adapter is TunneledAdapter {
  return TUNNELED_ADAPTER in adapter;
}

export async function openTunneledAdapter(deps: TunneledAdapterDeps): Promise<TunneledAdapter> {
  const now = deps.now ?? Date.now;

  let tunnel = await deps.openTunnel();
  let inner: DatabaseAdapter;
  try {
    inner = await deps.buildInner(tunnel.localPort);
  } catch (error: unknown) {
    await closeQuietly(tunnel);
    throw asConnectionError(error);
  }

  let lastUsed = now();
  let live = true;
  let closed = false;
  let refresh: Promise<void> | undefined;

  /** Drops the current pair. Never throws: the forward has to go regardless. */
  async function teardown(): Promise<void> {
    live = false;
    const [staleInner, staleTunnel] = [inner, tunnel];
    try {
      await staleInner.close?.();
    } catch {
      // An adapter that cannot close is already gone; the forward it was
      // using is what actually needs releasing.
    }
    await closeQuietly(staleTunnel);
  }

  async function rebuild(): Promise<void> {
    await teardown();

    const nextTunnel = await deps.openTunnel().catch((error: unknown) => {
      throw asConnectionError(error);
    });
    try {
      inner = await deps.buildInner(nextTunnel.localPort);
    } catch (error: unknown) {
      await closeQuietly(nextTunnel);
      throw asConnectionError(error);
    }

    tunnel = nextTunnel;
    live = true;
    lastUsed = now();
  }

  /** One refresh at a time, so two idle callers open one forward, not two. */
  function once(run: () => Promise<void>): Promise<void> {
    refresh ??= run().finally(() => {
      refresh = undefined;
    });
    return refresh;
  }

  async function checkOrRebuild(): Promise<void> {
    if (!live) {
      await rebuild();
      return;
    }
    if (now() - lastUsed < HEALTH_CHECK_AFTER_IDLE_MS) return;
    try {
      await inner.executeQuery(PROBE_SQL);
    } catch {
      // Why the failure came back does not change what to do about it: the
      // connection this adapter is holding cannot serve the caller.
      await rebuild();
    }
  }

  async function borrow(): Promise<DatabaseAdapter> {
    if (closed) {
      throw new ConnectionError("this connection was closed");
    }
    await once(checkOrRebuild);
    return inner;
  }

  async function call<T>(run: (adapter: DatabaseAdapter) => Promise<T>): Promise<T> {
    const current = await borrow();
    try {
      return await run(current);
    } finally {
      lastUsed = now();
    }
  }

  // Absence is the "not supported" signal the use cases read, so the wrapper
  // exposes exactly the hooks the inner adapter has. Presence is fixed at
  // open: a rebuild runs the same `buildInner`, so it produces the same
  // shape — `required` covers the case where somehow it did not, rather than
  // calling `undefined`.
  const optional: Partial<DatabaseAdapter> = {};
  if (inner.describeTable !== undefined) {
    optional.describeTable = async (table: TableInfo): Promise<TableSchema> =>
      call(async (a) => required(a.describeTable, "describeTable").call(a, table));
  }
  if (inner.execute !== undefined) {
    optional.execute = async (sql: string): Promise<number> =>
      call(async (a) => required(a.execute, "execute").call(a, sql));
  }
  if (inner.executeInTransaction !== undefined) {
    optional.executeInTransaction = async (statements: readonly string[]): Promise<void> =>
      call(async (a) =>
        required(a.executeInTransaction, "executeInTransaction").call(a, statements),
      );
  }
  if (inner.tableDdl !== undefined) {
    optional.tableDdl = async (table: TableInfo): Promise<string> =>
      call(async (a) => required(a.tableDdl, "tableDdl").call(a, table));
  }

  return {
    [TUNNELED_ADAPTER]: true,
    // Identity and capabilities are metadata: they answer for the driver,
    // not for the socket, so they do not wait on a health check.
    getId: (): string => inner.getId(),
    getCapabilities: (): Capabilities => inner.getCapabilities(),
    listTables: async (): Promise<TableInfo[]> => call(async (a) => a.listTables()),
    executeQuery: async (sql: string): Promise<QueryResult> =>
      call(async (a) => a.executeQuery(sql)),
    ...optional,
    // Deliberately not health-checked: the caller is about to replace this
    // adapter, and probing a connection on its way out would trade a round
    // trip for nothing. What it wants is the credential, which a stale
    // adapter still holds.
    unwrap: (): DatabaseAdapter => inner,
    reconnect: async (): Promise<void> => {
      if (closed) {
        throw new ConnectionError("this connection was closed");
      }
      // Joining an in-flight probe would let a reconnect return without
      // having reconnected, so wait it out first and then force one.
      await refresh?.catch(() => undefined);
      await once(rebuild);
    },
    close: async (): Promise<void> => {
      if (closed) return;
      closed = true;
      if (live) await teardown();
    },
  };
}

function required<T>(hook: T | undefined, name: string): T {
  if (hook === undefined) {
    throw new CapabilityError(`the reconnected adapter no longer supports ${name}`);
  }
  return hook;
}

async function closeQuietly(tunnel: SshTunnelHandle): Promise<void> {
  try {
    await tunnel.close();
  } catch {
    // Nothing left to do about a forward that will not close, and reporting
    // it would replace whatever error sent us here.
  }
}

function asConnectionError(error: unknown): ConnectionError {
  if (error instanceof ConnectionError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  return new ConnectionError(`could not reopen the ssh tunnel: ${detail}`, { cause: error });
}
