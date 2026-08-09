import { describe, expect, it, vi } from "vitest";

import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { ConnectionError } from "../domain/errors";
import { NULL_CAPABILITIES, type QueryResult, type TableInfo } from "../domain/values";
import type { SshTunnelHandle } from "./ssh-tunnel";
import {
  HEALTH_CHECK_AFTER_IDLE_MS,
  isTunneledAdapter,
  openTunneledAdapter,
} from "./tunneled-adapter";

const EMPTY: QueryResult = { columns: [], rows: [], rows_affected: 0 };
const USERS: TableInfo = { schema: "public", name: "users" };

interface InnerOptions {
  failFrom?: number;
  omitOptional?: boolean;
}

/** A stand-in for whatever adapter the factory would have built. */
class FakeInner implements DatabaseAdapter {
  readonly calls: string[] = [];
  closed = false;

  constructor(
    readonly label: string,
    private readonly options: InnerOptions = {},
  ) {
    if (options.omitOptional !== true) {
      this.execute = async (sql: string) => {
        this.calls.push(`execute:${sql}`);
        return 1;
      };
      this.describeTable = async (table: TableInfo) => {
        this.calls.push(`describeTable:${table.name}`);
        return { table, columns: [], primary_key: [] };
      };
      this.executeInTransaction = async (statements: readonly string[]) => {
        this.calls.push(`executeInTransaction:${statements.length}`);
      };
      this.tableDdl = async (table: TableInfo) => {
        this.calls.push(`tableDdl:${table.name}`);
        return `CREATE TABLE ${table.name} ();`;
      };
    }
  }

  execute?: (sql: string) => Promise<number>;
  describeTable?: DatabaseAdapter["describeTable"];
  executeInTransaction?: DatabaseAdapter["executeInTransaction"];
  tableDdl?: DatabaseAdapter["tableDdl"];

  getId(): string {
    return "fake";
  }

  getCapabilities() {
    return { ...NULL_CAPABILITIES, has_execute: true };
  }

  async listTables(): Promise<TableInfo[]> {
    this.calls.push("listTables");
    return [USERS];
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    this.calls.push(`executeQuery:${sql}`);
    if (this.options.failFrom !== undefined && this.calls.length >= this.options.failFrom) {
      throw new ConnectionError("connection is closed");
    }
    return EMPTY;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

class FakeTunnel implements SshTunnelHandle {
  closed = false;
  constructor(readonly localPort: number) {}
  async close(): Promise<void> {
    this.closed = true;
  }
}

/** A clock the test drives, so an idle window costs no wall time. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

interface HarnessOptions {
  inner?: (port: number, generation: number) => FakeInner;
  openTunnel?: () => Promise<SshTunnelHandle>;
}

function harness(options: HarnessOptions = {}) {
  const time = clock();
  const tunnels: FakeTunnel[] = [];
  const inners: FakeInner[] = [];

  const openTunnel =
    options.openTunnel ??
    (async () => {
      const tunnel = new FakeTunnel(15_000 + tunnels.length);
      tunnels.push(tunnel);
      return tunnel;
    });

  const buildInner = async (localPort: number) => {
    const inner =
      options.inner?.(localPort, inners.length) ?? new FakeInner(`inner-${inners.length}`);
    inners.push(inner);
    return inner;
  };

  return { time, tunnels, inners, openTunnel, buildInner };
}

describe("openTunneledAdapter", () => {
  it("opens the forward and builds the inner adapter against it", async () => {
    const h = harness();
    const ports: number[] = [];
    const adapter = await openTunneledAdapter({
      openTunnel: h.openTunnel,
      buildInner: async (port) => {
        ports.push(port);
        const inner = new FakeInner("inner-0");
        h.inners.push(inner);
        return inner;
      },
      now: h.time.now,
    });

    expect(ports).toEqual([15_000]);
    expect(adapter.getId()).toBe("fake");
  });

  it("delegates the required surface", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    expect(adapter.getCapabilities().has_execute).toBe(true);
    await adapter.listTables();
    await adapter.executeQuery("select 1");

    expect(h.inners[0]?.calls).toEqual(["listTables", "executeQuery:select 1"]);
  });

  it("delegates the optional surface", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.execute?.("update users set a = 1");
    await adapter.describeTable?.(USERS);
    await adapter.executeInTransaction?.(["a", "b"]);
    await adapter.tableDdl?.(USERS);

    expect(h.inners[0]?.calls).toEqual([
      "execute:update users set a = 1",
      "describeTable:users",
      "executeInTransaction:2",
      "tableDdl:users",
    ]);
  });

  it("does not offer a hook the inner adapter does not have", async () => {
    // Absence is the "not supported" signal the use cases read, so a wrapper
    // that always answers would turn every CapabilityError into a crash.
    const h = harness({ inner: () => new FakeInner("bare", { omitOptional: true }) });
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    expect(adapter.describeTable).toBeUndefined();
    expect(adapter.execute).toBeUndefined();
    expect(adapter.executeInTransaction).toBeUndefined();
    expect(adapter.tableDdl).toBeUndefined();
  });

  it("does not probe a connection that was just used", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.listTables();
    h.time.advance(HEALTH_CHECK_AFTER_IDLE_MS - 1);
    await adapter.listTables();

    expect(h.inners[0]?.calls).toEqual(["listTables", "listTables"]);
  });

  it("probes a connection that has been idle", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.listTables();
    h.time.advance(HEALTH_CHECK_AFTER_IDLE_MS);
    await adapter.listTables();

    // Web's port has no `ping`, so the probe is the cheapest round trip both
    // engines understand.
    expect(h.inners[0]?.calls).toEqual(["listTables", "executeQuery:SELECT 1", "listTables"]);
  });

  it("reopens the forward when the probe fails", async () => {
    const h = harness({
      inner: (_port, generation) =>
        generation === 0 ? new FakeInner("stale", { failFrom: 1 }) : new FakeInner("fresh"),
    });
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    h.time.advance(HEALTH_CHECK_AFTER_IDLE_MS);
    await adapter.listTables();

    expect(h.tunnels).toHaveLength(2);
    expect(h.inners).toHaveLength(2);
    expect(h.inners[1]?.calls).toEqual(["listTables"]);
  });

  it("tears the stale forward down rather than leaking it", async () => {
    const h = harness({
      inner: (_port, generation) =>
        generation === 0 ? new FakeInner("stale", { failFrom: 1 }) : new FakeInner("fresh"),
    });
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    h.time.advance(HEALTH_CHECK_AFTER_IDLE_MS);
    await adapter.listTables();

    expect(h.inners[0]?.closed).toBe(true);
    expect(h.tunnels[0]?.closed).toBe(true);
    expect(h.tunnels[1]?.closed).toBe(false);
  });

  it("rebuilds once when two callers arrive at the same stale connection", async () => {
    const h = harness({
      inner: (_port, generation) =>
        generation === 0 ? new FakeInner("stale", { failFrom: 1 }) : new FakeInner("fresh"),
    });
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    h.time.advance(HEALTH_CHECK_AFTER_IDLE_MS);
    await Promise.all([adapter.listTables(), adapter.listTables()]);

    expect(h.tunnels).toHaveLength(2);
    expect(h.inners).toHaveLength(2);
  });

  it("reports a failed rebuild as a connection error", async () => {
    let opened = 0;
    const h = harness({
      inner: () => new FakeInner("stale", { failFrom: 1 }),
      openTunnel: async () => {
        opened += 1;
        if (opened > 1) throw new Error("bastion is gone");
        return new FakeTunnel(15_000);
      },
    });
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    h.time.advance(HEALTH_CHECK_AFTER_IDLE_MS);
    await expect(adapter.listTables()).rejects.toBeInstanceOf(ConnectionError);
  });

  it("can be told to reconnect without waiting for the idle window", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.reconnect();

    expect(h.tunnels).toHaveLength(2);
    expect(h.inners).toHaveLength(2);
    expect(h.tunnels[0]?.closed).toBe(true);
  });

  it("closes the inner adapter and the forward together", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.close?.();

    expect(h.inners[0]?.closed).toBe(true);
    expect(h.tunnels[0]?.closed).toBe(true);
  });

  it("is safe to close twice", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.close?.();
    await expect(adapter.close?.()).resolves.toBeUndefined();
  });

  it("refuses to serve a closed adapter rather than reopening the forward", async () => {
    // DELETE /connections closed this on purpose; silently dialling the
    // bastion again would resurrect a connection the operator retired.
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.close?.();

    await expect(adapter.listTables()).rejects.toBeInstanceOf(ConnectionError);
    expect(h.tunnels).toHaveLength(1);
  });

  it("is recognisable as tunneled, and a plain adapter is not", async () => {
    // How `rebuild` finds the driver underneath. A duck-type check would be
    // answered by any adapter that happens to grow a `reconnect`.
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    expect(isTunneledAdapter(adapter)).toBe(true);
    expect(isTunneledAdapter(new FakeInner("direct"))).toBe(false);
  });

  it("hands back the adapter underneath, so an edit can rebuild from it", async () => {
    // Web keeps no keyring: the password an edit left blank exists only
    // inside the adapter serving the connection (ADR-0080).
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    expect(isTunneledAdapter(adapter) && adapter.unwrap()).toBe(h.inners[0]);
  });

  it("hands back the current adapter after a reconnect, not the stale one", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });

    await adapter.reconnect();

    expect(isTunneledAdapter(adapter) && adapter.unwrap()).toBe(h.inners[1]);
  });

  it("still tears down the forward when the inner adapter fails to close", async () => {
    const h = harness();
    const adapter = await openTunneledAdapter({ ...h, now: h.time.now });
    const inner = h.inners[0];
    if (inner === undefined) throw new Error("no inner");
    inner.close = vi.fn().mockRejectedValue(new Error("already gone"));

    await adapter.close?.();

    expect(h.tunnels[0]?.closed).toBe(true);
  });
});
