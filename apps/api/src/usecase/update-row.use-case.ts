import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, ConflictError, QueryError } from "../domain/errors";
import { buildUpdateSql, WriteBackError, type UpdatePlan } from "../domain/write-back";
import type { ConnectionRegistry } from "./connection-registry.port";

// The service's first write path (desktop ADR-0042, as shipped in ADR-0063).
// Everything about it is arranged so that the only statement it can send is
// one it built itself, keyed on a row identity the caller supplied from a
// result it had already read.
//
// The SQL is built in `domain/write-back.ts`, not here: this layer resolves
// the adapter, runs the statement, and checks what it hit. Keeping the two
// apart is what lets the escaping be tested adversarially without a
// connection anywhere near it.
export class UpdateRow {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  /**
   * Apply `plan` as a single `UPDATE` and return the number of rows it
   * changed — which is always 1, because anything else throws.
   *
   * @throws {CapabilityError} unknown connection, or an adapter with no
   * write primitive (404).
   * @throws {QueryError} the plan itself was refused — no edits, no key, or
   * a blob identity value (400). Nothing was sent.
   * @throws {ConflictError} the statement ran but did not change exactly
   * one row (409).
   */
  async execute(connectionId: string | undefined, plan: UpdatePlan): Promise<number> {
    const adapter = this.resolveAdapter(connectionId);
    if (!adapter.execute) {
      throw new CapabilityError(`adapter cannot write: ${adapter.getId()}`);
    }

    // Built before anything is sent, so a refusal costs a round trip of
    // nothing. An empty key is the case this ordering exists for: the
    // alternative is discovering it from an affected count after an
    // unkeyed UPDATE has already rewritten the table.
    const sql = this.buildOrRefuse(plan);
    const affected = await adapter.execute(sql);

    // The key is a declared primary key, so a well-formed plan can only
    // match zero or one row. Both other outcomes are reported rather than
    // guessed at, which is desktop's gate exactly.
    //
    // Honest limitation, inherited from desktop: this is a bare statement,
    // not a transaction, so by the time a count other than 1 is visible the
    // write has already committed. For 0 that is harmless — nothing
    // matched, nothing changed. For >1 it means the catalog named a
    // "primary key" that is not unique, and several rows now hold the new
    // value. Rolling that back needs a transactional primitive, which
    // arrives with restore's `executeInTransaction` (ADR-0051, rung 6b).
    if (affected === 1) return affected;
    if (affected === 0) {
      throw new ConflictError(
        "no row matched — it may have been changed or deleted since it was loaded",
      );
    }
    throw new ConflictError(
      `expected to update exactly one row but ${affected} matched — the key columns are not unique`,
    );
  }

  // A refused plan is the caller's fault, not the engine's, and it never
  // reaches the engine. Re-typed rather than rethrown as-is so it carries a
  // category the error filter knows; the reason is kept verbatim because it
  // already names the specific problem.
  private buildOrRefuse(plan: UpdatePlan): string {
    try {
      return buildUpdateSql(plan);
    } catch (e) {
      if (e instanceof WriteBackError) throw new QueryError(e.message);
      throw e;
    }
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
