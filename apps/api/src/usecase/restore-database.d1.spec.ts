import { describe, expect, it } from "vitest";
import { D1Adapter, type D1Response, type D1Transport } from "../infrastructure/d1-adapter";
import { RestoreDatabase } from "./restore-database.use-case";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";

// Ticket 0031's definition of done: "the restore per-statement branch is
// exercised against D1, not only in a unit test with a stub."
//
// `restore-database.use-case.spec.ts` covers the branch's behaviour with a
// FakeAdapter that omits `executeInTransaction` on request. What it cannot
// show is that a real adapter omits it — the fake is told which path to
// take, so it would keep passing if `D1Adapter` grew an atomic hook or
// reported `has_atomic_restore: true`. Here the runner is handed the real
// class and picks the branch itself; the only stub is the socket.
//
// The branch stopped being dead code with 0031 slice B. These tests are what
// says so.

class ScriptedTransport implements D1Transport {
  readonly sent: string[] = [];

  constructor(private readonly failOn: ReadonlySet<string> = new Set()) {}

  post(sql: string): Promise<D1Response> {
    this.sent.push(sql);
    if (this.failOn.has(sql)) {
      return Promise.resolve({
        status: 400,
        body: JSON.stringify({ success: false, errors: [{ code: 7500, message: "refused" }] }),
      });
    }
    return Promise.resolve({
      status: 200,
      body: JSON.stringify({
        success: true,
        // `/raw` answers a write with the same envelope as a read.
        result: [{ results: { columns: [], rows: [] }, meta: { changes: 1 } }],
        errors: [],
      }),
    });
  }
}

// Every test below restores to the default adapter, so the registry is only
// here to satisfy the constructor — an empty one makes that explicit.
class EmptyRegistry implements ConnectionRegistry {
  add(): void {
    throw new Error("the D1 restore tests never register a connection");
  }
  list(): ConnectionRecord[] {
    return [];
  }
  get(): ConnectionRecord | undefined {
    return undefined;
  }
  delete(): boolean {
    return false;
  }
}

const DDL = 'CREATE TABLE "a" ("id" integer)';
const FIRST = 'INSERT INTO "a" VALUES (1)';
const SECOND = 'INSERT INTO "a" VALUES (2)';
const SCRIPT = `${DDL};\n${FIRST};\n${SECOND};\n`;

// D1's own `SELECT name FROM sqlite_master …`, which `prepare` runs to find
// out whether the target is empty. Answering with no rows keeps every test
// below on the empty-target path, so nothing needs `confirmed`.
function restoreOn(transport: D1Transport): RestoreDatabase {
  return new RestoreDatabase(new D1Adapter(transport), new EmptyRegistry());
}

describe("RestoreDatabase against a real D1Adapter", () => {
  it("takes the per-statement branch because the adapter has no atomic hook", async () => {
    const transport = new ScriptedTransport();
    const restore = restoreOn(transport);

    const outcome = await restore.run(await restore.prepare(undefined, SCRIPT));

    // `atomic: false` is the runner reporting which branch it took, and the
    // client sees it — a restore that half-applied must not be described as
    // one that either committed or did not.
    expect(outcome.atomic).toBe(false);
    expect(outcome.statementsRun).toBe(3);
    expect(outcome.ddlRun).toBe(1);
    expect(outcome.dataRun).toBe(2);
    expect(outcome.failures).toEqual([]);
  });

  it("sends each statement as its own request, because /raw takes one", async () => {
    const transport = new ScriptedTransport();
    const restore = restoreOn(transport);

    await restore.run(await restore.prepare(undefined, SCRIPT));

    // The listTables probe from `prepare`, then one POST per statement.
    expect(transport.sent.slice(1)).toEqual([DDL, FIRST, SECOND]);
  });

  it("reports a mid-script failure and keeps going, leaving the rest applied", async () => {
    // The half-applied outcome the atomic branch exists to avoid, and the
    // reason `has_atomic_restore` is part of the contract rather than an
    // implementation detail: on D1 this is the only available answer.
    const transport = new ScriptedTransport(new Set([FIRST]));
    const restore = restoreOn(transport);

    const outcome = await restore.run(await restore.prepare(undefined, SCRIPT), {
      onError: "continue",
      confirmed: false,
    });

    expect(outcome.failures).toEqual([{ index: 1, message: expect.stringContaining("refused") }]);
    expect(outcome.statementsRun).toBe(2);
    expect(transport.sent.slice(1)).toEqual([DDL, FIRST, SECOND]);
  });

  it("stops at the first failure when asked to", async () => {
    const transport = new ScriptedTransport(new Set([FIRST]));
    const restore = restoreOn(transport);

    const outcome = await restore.run(await restore.prepare(undefined, SCRIPT), {
      onError: "stop",
      confirmed: false,
    });

    expect(outcome.failures).toHaveLength(1);
    // The second INSERT was never sent — "stop" has to reach the wire, not
    // just the count.
    expect(transport.sent.slice(1)).toEqual([DDL, FIRST]);
  });
});
