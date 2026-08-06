import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, QueryError } from "../domain/errors";
import { classifyScript, runnableStatements, type RestoreStatement } from "../domain/restore/plan";
import type { TableInfo } from "../domain/values";
import type { ConnectionRegistry } from "./connection-registry.port";

/** What to do when a statement fails on the per-statement (non-atomic) path. */
export type OnError = "stop" | "continue";

/** Options for a restore run. */
export interface RestoreOptions {
  /**
   * The caller has confirmed applying to a non-empty target. Ignored when the
   * target is already empty.
   */
  confirmed: boolean;
  /**
   * Per-statement failure policy. Ignored on the atomic path, where a batch
   * is all-or-nothing by construction.
   */
  onError: OnError;
}

/**
 * Unconfirmed, and stop at the first failure — the safest of the four
 * combinations, and the one a caller that says nothing should get. Without a
 * transaction, a later statement usually depends on the one that failed.
 */
export const DEFAULT_RESTORE_OPTIONS: RestoreOptions = { confirmed: false, onError: "stop" };

/**
 * A restore preflight: the classified script plus the target's current tables.
 * An empty `existingTables` is the case that may run without confirmation.
 */
export interface RestorePlan {
  statements: RestoreStatement[];
  existingTables: string[];
}

/** A preflighted restore: the adapter to apply to, and the plan to apply. */
export interface PreparedRestore {
  adapter: DatabaseAdapter;
  plan: RestorePlan;
}

/** A statement that failed to apply on the per-statement path. */
export interface StatementFailure {
  /** 0-based position among the **runnable** statements. */
  index: number;
  message: string;
}

/** The result of a completed — or cancelled — restore. */
export interface RestoreOutcome {
  statementsRun: number;
  ddlRun: number;
  dataRun: number;
  failures: StatementFailure[];
  cancelled: boolean;
  /** True if the script ran as one atomic batch. */
  atomic: boolean;
}

/** True when the target has no user tables — the unconfirmed-safe case. */
export function isTargetEmpty(plan: RestorePlan): boolean {
  return plan.existingTables.length === 0;
}

/**
 * Whole-connection logical restore (desktop ADR-0051 / ADR-0065) — the web
 * mirror of `crates/dbboard-core/src/restore/run.rs`, and the write-side
 * counterpart of {@link DumpDatabase}.
 *
 * Split into `prepare` / `run` for the reason dump was, arrived at from the
 * other direction: everything that can refuse the request resolves before
 * anything is applied. Restore carries the inverse risk of every rung before
 * it — it executes statements web neither wrote nor can vouch for — so the
 * safety model is not "escape it correctly" but "refuse to run it against a
 * target where it could destroy something".
 *
 * Two gates, in desktop's order:
 *
 * 1. **Empty target.** A target that already has tables is refused unless the
 *    caller confirms. This is ADR-0051's "empty / new targets only" model, and
 *    it comes first because it is the refusal the caller can act on.
 * 2. **Capability.** An adapter with no `execute` cannot restore at all.
 *
 * Then one of two paths, chosen by the adapter rather than by the caller: an
 * adapter with `executeInTransaction` applies the whole script as one batch,
 * and one with only `execute` applies statements one at a time under an
 * {@link OnError} policy. The second path is unreachable on today's adapter
 * set and is not dead code — see {@link RestoreDatabase.runPerStatement}.
 *
 * ## What web does not mirror
 *
 * Desktop's `RestoreControl` carries progress out and cancellation in.
 * Progress has no home in a single JSON response, so it is dropped: the
 * outcome reports what was applied, once. Cancellation survives as an
 * `AbortSignal` — the request going away — with desktop's semantics intact:
 * observed between statements on the per-statement path, once before the
 * batch on the atomic one, and **not an error**.
 *
 * The plan is never handed back in to be run. ADR-0065 makes re-plan-on-run a
 * correctness rule — it is what makes a stale plan unexecutable — so the run
 * route calls `prepare` itself from the script it was posted, and the plan
 * exists only inside the request that built it.
 */
export class RestoreDatabase {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  /**
   * Resolve the adapter, classify `script`, and record what the target
   * already holds.
   *
   * Reads only — nothing here can change the database.
   *
   * @throws {CapabilityError} unknown connection (404).
   * @throws whatever `listTables` raises.
   */
  async prepare(connectionId: string | undefined, script: string): Promise<PreparedRestore> {
    const adapter = this.resolveAdapter(connectionId);
    const tables = await adapter.listTables();

    return {
      adapter,
      plan: {
        statements: classifyScript(script),
        existingTables: tables.map(displayName),
      },
    };
  }

  /**
   * Apply `prepared` to its adapter.
   *
   * @throws {QueryError} the target is not empty and `confirmed` was not set
   * (400), or the atomic batch failed as a unit — in which case nothing was
   * applied.
   * @throws {CapabilityError} the adapter cannot execute statements (404).
   */
  async run(
    prepared: PreparedRestore,
    options: RestoreOptions = DEFAULT_RESTORE_OPTIONS,
    signal?: AbortSignal,
  ): Promise<RestoreOutcome> {
    const { adapter, plan } = prepared;

    if (!isTargetEmpty(plan) && !options.confirmed) {
      // The count, not the names: the error envelope carries a category and a
      // message and nothing else. The plan response already handed the caller
      // the list, so the UI can say which tables are in the way.
      throw new QueryError(
        `restore target is not empty (${plan.existingTables.length} existing table(s)); re-send with confirmed=true to apply it anyway`,
      );
    }

    if (!adapter.execute) {
      throw new CapabilityError(`adapter cannot execute statements: ${adapter.getId()}`);
    }

    const runnable = runnableStatements(plan.statements);

    return adapter.executeInTransaction
      ? await this.runAtomic(adapter, runnable, signal)
      : await this.runPerStatement(adapter, runnable, options.onError, signal);
  }

  /**
   * Apply every statement as one batch. Cancellation can only be observed
   * before it starts — the adapter call is indivisible by definition.
   */
  private async runAtomic(
    adapter: DatabaseAdapter,
    runnable: readonly RestoreStatement[],
    signal: AbortSignal | undefined,
  ): Promise<RestoreOutcome> {
    if (signal?.aborted) {
      return { ...emptyOutcome(), cancelled: true, atomic: true };
    }

    try {
      // An empty batch needs no special case: the port defines it as a no-op.
      await adapter.executeInTransaction!(runnable.map((s) => s.sql));
    } catch (e) {
      throw new QueryError(`restore transaction failed: ${messageOf(e)}`);
    }

    return {
      statementsRun: runnable.length,
      ddlRun: countKind(runnable, "ddl"),
      dataRun: countKind(runnable, "data"),
      failures: [],
      cancelled: false,
      atomic: true,
    };
  }

  /**
   * Apply statements one at a time, honouring `onError` and stopping between
   * statements if the request goes away.
   *
   * **Reached by Cloudflare D1** (0031 slice B), and by nothing else today.
   * Postgres and Turso both advertise the atomic hook; NullAdapter has
   * neither and is refused a step earlier. D1's REST API takes one statement
   * per request and has no multi-statement transaction, so `D1Adapter`
   * implements `execute` and not `executeInTransaction` — which is precisely
   * the split desktop wrote this branch for (ADR-0051). When this shipped it
   * was dead code kept against that arrival; `restore-database.d1.spec.ts`
   * now drives it with a real adapter rather than a stub, so the dispatch
   * itself is what the test proves.
   */
  private async runPerStatement(
    adapter: DatabaseAdapter,
    runnable: readonly RestoreStatement[],
    onError: OnError,
    signal: AbortSignal | undefined,
  ): Promise<RestoreOutcome> {
    const outcome: RestoreOutcome = { ...emptyOutcome(), atomic: false };

    for (const [index, statement] of runnable.entries()) {
      if (signal?.aborted) {
        outcome.cancelled = true;
        break;
      }

      try {
        await adapter.execute!(statement.sql);
      } catch (e) {
        // Non-fatal: a per-statement failure is reported, not thrown. Only a
        // whole run that could not start is an error.
        outcome.failures.push({ index, message: messageOf(e) });
        if (onError === "stop") break;
        continue;
      }

      outcome.statementsRun += 1;
      if (statement.kind === "ddl") outcome.ddlRun += 1;
      if (statement.kind === "data") outcome.dataRun += 1;
    }

    return outcome;
  }

  private resolveAdapter(connectionId: string | undefined): DatabaseAdapter {
    if (connectionId === undefined) return this.defaultAdapter;
    const record = this.registry.get(connectionId);
    if (!record) {
      throw new CapabilityError(`unknown connection: ${connectionId}`);
    }
    return record.adapter;
  }
}

function emptyOutcome(): RestoreOutcome {
  return {
    statementsRun: 0,
    ddlRun: 0,
    dataRun: 0,
    failures: [],
    cancelled: false,
    atomic: false,
  };
}

function countKind(
  statements: readonly RestoreStatement[],
  kind: RestoreStatement["kind"],
): number {
  return statements.filter((s) => s.kind === kind).length;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function displayName(table: TableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}
