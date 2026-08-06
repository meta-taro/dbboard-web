import { describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, QueryError } from "../domain/errors";
import {
  NULL_CAPABILITIES,
  type Capabilities,
  type QueryResult,
  type TableInfo,
} from "../domain/values";
import { RestoreDatabase, isTargetEmpty } from "./restore-database.use-case";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";

function table(name: string, schema: string | null = "public"): TableInfo {
  return { schema, name };
}

interface FakeOptions {
  tables?: TableInfo[];
  listTablesError?: Error;
  /** Keyed by statement text; the value is thrown instead of applied. */
  fail?: Record<string, Error>;
  batchError?: Error;
  omitExecute?: boolean;
  omitTransaction?: boolean;
  /** Called after each `execute`, so a test can abort mid-run. */
  afterExecute?: (sql: string) => void;
}

// Records what the runner sent and how. `omitTransaction` picks the
// per-statement path the way a real adapter does — by not having the method,
// which is the port's "not supported" signal.
class FakeAdapter implements DatabaseAdapter {
  readonly executed: string[] = [];
  readonly batches: string[][] = [];
  readonly execute?: (sql: string) => Promise<number>;
  readonly executeInTransaction?: (statements: readonly string[]) => Promise<void>;

  constructor(private readonly options: FakeOptions = {}) {
    if (!options.omitExecute) this.execute = (sql) => this.runOne(sql);
    if (!options.omitTransaction) this.executeInTransaction = (s) => this.runBatch(s);
  }

  getId(): string {
    return "fake";
  }

  getCapabilities(): Capabilities {
    return NULL_CAPABILITIES;
  }

  async listTables(): Promise<TableInfo[]> {
    if (this.options.listTablesError) throw this.options.listTablesError;
    return this.options.tables ?? [];
  }

  async executeQuery(): Promise<QueryResult> {
    throw new Error("restore never reads");
  }

  private async runOne(sql: string): Promise<number> {
    const failure = this.options.fail?.[sql];
    if (failure) throw failure;
    this.executed.push(sql);
    this.options.afterExecute?.(sql);
    return 0;
  }

  private async runBatch(statements: readonly string[]): Promise<void> {
    if (this.options.batchError) throw this.options.batchError;
    this.batches.push([...statements]);
  }
}

class StubRegistry implements ConnectionRegistry {
  private readonly records = new Map<string, ConnectionRecord>();

  add(record: ConnectionRecord): void {
    this.records.set(record.id, record);
  }

  list(): ConnectionRecord[] {
    return [...this.records.values()];
  }

  get(id: string): ConnectionRecord | undefined {
    return this.records.get(id);
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }
}

function useCase(adapter: DatabaseAdapter, registry = new StubRegistry()): RestoreDatabase {
  return new RestoreDatabase(adapter, registry);
}

const SCRIPT = 'CREATE TABLE "a" ("id" integer);\nINSERT INTO "a" VALUES (1);\n';

describe("RestoreDatabase.prepare", () => {
  it("classifies the script and lists the target's tables", async () => {
    const adapter = new FakeAdapter({ tables: [table("a"), table("b")] });

    const prepared = await useCase(adapter).prepare(undefined, SCRIPT);

    expect(prepared.plan.statements.map((s) => s.kind)).toEqual(["ddl", "data"]);
    expect(prepared.plan.existingTables).toEqual(["public.a", "public.b"]);
    expect(isTargetEmpty(prepared.plan)).toBe(false);
  });

  it("reports an empty target as empty", async () => {
    const prepared = await useCase(new FakeAdapter()).prepare(undefined, SCRIPT);

    expect(prepared.plan.existingTables).toEqual([]);
    expect(isTargetEmpty(prepared.plan)).toBe(true);
  });

  it("names an unqualified table without a leading dot", async () => {
    const adapter = new FakeAdapter({ tables: [table("a", null)] });

    const prepared = await useCase(adapter).prepare(undefined, SCRIPT);

    expect(prepared.plan.existingTables).toEqual(["a"]);
  });

  it("propagates a listTables failure", async () => {
    const adapter = new FakeAdapter({ listTablesError: new QueryError("catalog unreadable") });

    await expect(useCase(adapter).prepare(undefined, SCRIPT)).rejects.toThrow(QueryError);
  });

  it("refuses an unknown connection", async () => {
    await expect(useCase(new FakeAdapter()).prepare("nope", SCRIPT)).rejects.toThrow(
      CapabilityError,
    );
  });

  it("restores into the connection's own adapter when an id is given", async () => {
    const scoped = new FakeAdapter({ tables: [table("scoped")] });
    const registry = new StubRegistry();
    registry.add({ id: "c1", label: "c1", driver: "fake", adapter: scoped });

    const prepared = await useCase(new FakeAdapter(), registry).prepare("c1", SCRIPT);

    expect(prepared.plan.existingTables).toEqual(["public.scoped"]);
  });
});

describe("RestoreDatabase.run — refusals", () => {
  it("refuses a non-empty target and names the count", async () => {
    const restore = useCase(new FakeAdapter({ tables: [table("a"), table("b")] }));
    const prepared = await restore.prepare(undefined, SCRIPT);

    await expect(restore.run(prepared)).rejects.toThrow(QueryError);
    await expect(restore.run(prepared)).rejects.toThrow(/2 existing table\(s\)/);
  });

  it("applies to a non-empty target once confirmed", async () => {
    const adapter = new FakeAdapter({ tables: [table("a")] });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    const outcome = await restore.run(prepared, { confirmed: true, onError: "stop" });

    expect(outcome.statementsRun).toBe(2);
  });

  it("refuses an adapter that cannot execute statements", async () => {
    const adapter = new FakeAdapter({ omitExecute: true, omitTransaction: true });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    await expect(restore.run(prepared)).rejects.toThrow(CapabilityError);
  });

  it("refuses an adapter with an atomic batch but no single-statement execute", async () => {
    // The two hooks travel with their flags, so this pairing should not
    // exist — desktop still gates on `has_execute` first, and mirroring that
    // keeps the refusal at the same boundary rather than half-running.
    const adapter = new FakeAdapter({ omitExecute: true });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    await expect(restore.run(prepared)).rejects.toThrow(CapabilityError);
  });

  it("checks the empty-target gate before the capability gate", async () => {
    // Both refusals apply; the safety gate is the one worth reporting,
    // because it is the one the caller can act on.
    const adapter = new FakeAdapter({
      tables: [table("a")],
      omitExecute: true,
      omitTransaction: true,
    });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    await expect(restore.run(prepared)).rejects.toThrow(QueryError);
  });
});

describe("RestoreDatabase.run — atomic path", () => {
  it("sends every runnable statement as one batch, in file order", async () => {
    const adapter = new FakeAdapter();
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    const outcome = await restore.run(prepared);

    expect(adapter.batches).toEqual([
      ['CREATE TABLE "a" ("id" integer)', 'INSERT INTO "a" VALUES (1)'],
    ]);
    expect(outcome).toEqual({
      statementsRun: 2,
      ddlRun: 1,
      dataRun: 1,
      failures: [],
      cancelled: false,
      atomic: true,
    });
  });

  it("strips the script's own transaction control", async () => {
    // The runner owns the boundary; a dump's BEGIN/COMMIT would nest.
    const adapter = new FakeAdapter();
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, `BEGIN;\n${SCRIPT}COMMIT;\n`);

    const outcome = await restore.run(prepared);

    expect(adapter.batches[0]).toEqual([
      'CREATE TABLE "a" ("id" integer)',
      'INSERT INTO "a" VALUES (1)',
    ]);
    expect(outcome.statementsRun).toBe(2);
  });

  it("never runs a statement on its own", async () => {
    const adapter = new FakeAdapter();
    const restore = useCase(adapter);

    await restore.run(await restore.prepare(undefined, SCRIPT));

    expect(adapter.executed).toEqual([]);
  });

  it("runs an unrecognised statement verbatim rather than dropping it", async () => {
    const adapter = new FakeAdapter();
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, "FROBNICATE everything");

    const outcome = await restore.run(prepared);

    expect(adapter.batches[0]).toEqual(["FROBNICATE everything"]);
    expect(outcome.statementsRun).toBe(1);
    expect(outcome.ddlRun).toBe(0);
    expect(outcome.dataRun).toBe(0);
  });

  it("reports a batch failure as a transaction failure", async () => {
    const adapter = new FakeAdapter({ batchError: new QueryError('relation "a" already exists') });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    await expect(restore.run(prepared)).rejects.toThrow(QueryError);
    await expect(restore.run(prepared)).rejects.toThrow(
      /restore transaction failed: relation "a" already exists/,
    );
  });

  it("does not start a batch that was already aborted", async () => {
    const adapter = new FakeAdapter();
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);
    const controller = new AbortController();
    controller.abort();

    const outcome = await restore.run(
      prepared,
      { confirmed: false, onError: "stop" },
      controller.signal,
    );

    expect(adapter.batches).toEqual([]);
    expect(outcome).toEqual({
      statementsRun: 0,
      ddlRun: 0,
      dataRun: 0,
      failures: [],
      cancelled: true,
      atomic: true,
    });
  });

  it("reports an empty script as a run of nothing", async () => {
    const restore = useCase(new FakeAdapter());
    const prepared = await restore.prepare(undefined, "-- nothing here\n");

    const outcome = await restore.run(prepared);

    expect(outcome.statementsRun).toBe(0);
    expect(outcome.cancelled).toBe(false);
  });
});

describe("RestoreDatabase.run — per-statement path", () => {
  // Unreachable on today's adapter set: Postgres advertises the atomic hook
  // and NullAdapter has neither. Built because rung 7 brings D1, whose HTTP
  // API has no multi-statement transaction — the branch is not dead code.
  function perStatement(options: FakeOptions = {}): FakeAdapter {
    return new FakeAdapter({ ...options, omitTransaction: true });
  }

  it("runs statements one at a time, in order", async () => {
    const adapter = perStatement();
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    const outcome = await restore.run(prepared);

    expect(adapter.executed).toEqual([
      'CREATE TABLE "a" ("id" integer)',
      'INSERT INTO "a" VALUES (1)',
    ]);
    expect(outcome).toEqual({
      statementsRun: 2,
      ddlRun: 1,
      dataRun: 1,
      failures: [],
      cancelled: false,
      atomic: false,
    });
  });

  it("stops at the first failure by default", async () => {
    const adapter = perStatement({
      fail: { 'CREATE TABLE "a" ("id" integer)': new QueryError("syntax error") },
    });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    const outcome = await restore.run(prepared);

    expect(adapter.executed).toEqual([]);
    expect(outcome.failures).toEqual([{ index: 0, message: "syntax error" }]);
    expect(outcome.statementsRun).toBe(0);
  });

  it("keeps going past a failure when told to continue", async () => {
    const adapter = perStatement({
      fail: { 'CREATE TABLE "a" ("id" integer)': new QueryError("syntax error") },
    });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    const outcome = await restore.run(prepared, { confirmed: false, onError: "continue" });

    expect(adapter.executed).toEqual(['INSERT INTO "a" VALUES (1)']);
    expect(outcome.failures).toEqual([{ index: 0, message: "syntax error" }]);
    expect(outcome.statementsRun).toBe(1);
    expect(outcome.dataRun).toBe(1);
  });

  it("indexes a failure by its position among the runnable statements", async () => {
    // Not the position in the file: transaction control was stripped, and an
    // index the caller cannot map back to what it sent is worse than none.
    const adapter = perStatement({
      fail: { 'INSERT INTO "a" VALUES (1)': new QueryError("no such table") },
    });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, `BEGIN;\n${SCRIPT}COMMIT;\n`);

    const outcome = await restore.run(prepared);

    expect(outcome.failures).toEqual([{ index: 1, message: "no such table" }]);
  });

  it("stops between statements when the request goes away", async () => {
    const controller = new AbortController();
    const adapter = perStatement({ afterExecute: () => controller.abort() });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    const outcome = await restore.run(
      prepared,
      { confirmed: false, onError: "stop" },
      controller.signal,
    );

    // Cancellation is not an error: what did apply is reported as applied.
    expect(adapter.executed).toEqual(['CREATE TABLE "a" ("id" integer)']);
    expect(outcome.cancelled).toBe(true);
    expect(outcome.statementsRun).toBe(1);
    expect(outcome.ddlRun).toBe(1);
  });

  it("reports a non-Error rejection without losing the run", async () => {
    const adapter = perStatement({
      fail: { 'CREATE TABLE "a" ("id" integer)': "boom" as unknown as Error },
    });
    const restore = useCase(adapter);
    const prepared = await restore.prepare(undefined, SCRIPT);

    const outcome = await restore.run(prepared, { confirmed: false, onError: "continue" });

    expect(outcome.failures).toEqual([{ index: 0, message: "boom" }]);
  });
});
