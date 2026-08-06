import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { dialectFor } from "../domain/dialect";
import { CapabilityError, QueryError } from "../domain/errors";
import { buildCount, buildSelectPage } from "../domain/dump/select";
import { buildInsert } from "../domain/dump/insert";
import {
  DEFAULT_BACKUP_WARN_ROWS,
  INSERT_BATCH_ROWS,
  READ_PAGE_ROWS,
  exceedsThreshold,
  type DumpPlan,
} from "../domain/dump/plan";
import type { TableInfo, Value } from "../domain/values";
import type { ConnectionRegistry } from "./connection-registry.port";

/**
 * A preflighted dump: the adapter it will read from, and the plan that
 * passed the size gate. Produced by {@link DumpDatabase.prepare}, consumed
 * by {@link DumpDatabase.run}.
 */
export interface PreparedDump {
  adapter: DatabaseAdapter;
  plan: DumpPlan;
}

/**
 * Whole-connection logical dump (desktop ADR-0049) — the web mirror of
 * `crates/dbboard-core/src/dump/run.rs`.
 *
 * Split in two on purpose. `prepare` does everything that can refuse the
 * request — unknown connection, an adapter that cannot reconstruct DDL, a
 * database over the size gate — and `run` is the async generator that
 * produces the SQL. A generator's body does not execute until it is first
 * pulled, so folding the refusals into it would move them *after* the route
 * had already begun a 200 response with its headers sent. Everything that
 * can produce a status code happens before a byte is written.
 *
 * The output is streamed statement by statement, never assembled: a dump is
 * unbounded by definition, and the one thing it must not do is hold the
 * database it is copying in memory. Cancellation is the client aborting the
 * response, which tears the generator down at its next suspension point —
 * there is no cancel token, and no progress channel over a plain download.
 *
 * Per-table failures are non-fatal (ADR-0049 Decision 10): the table becomes
 * a comment naming what went wrong and the dump continues. Losing the rest
 * of a backup over one unreadable table is the worse outcome.
 */
export class DumpDatabase {
  constructor(
    private readonly defaultAdapter: DatabaseAdapter,
    private readonly registry: ConnectionRegistry,
  ) {}

  /**
   * Resolve the adapter, count every table, and apply the size gate.
   *
   * @throws {CapabilityError} unknown connection, or an adapter with no DDL
   * reconstruction (404).
   * @throws {QueryError} the database is over
   * {@link DEFAULT_BACKUP_WARN_ROWS} and `confirm` was not set (400).
   * Anything `listTables` raises also surfaces here.
   */
  async prepare(connectionId: string | undefined, confirm = false): Promise<PreparedDump> {
    const adapter = this.resolveAdapter(connectionId);

    // Data alone cannot be loaded into an empty database, which is the one
    // thing a dump promises. Desktop skips the DDL section for adapters
    // that cannot produce it because it dumps engines web does not ship;
    // here the only such adapter is NullAdapter, so refusing is both
    // simpler and more honest than emitting a file that cannot be restored.
    if (!adapter.tableDdl) {
      throw new CapabilityError(`adapter cannot reconstruct table DDL: ${adapter.getId()}`);
    }

    const tables = await adapter.listTables();
    const plan: DumpPlan = { tables: [] };
    for (const table of tables) {
      plan.tables.push({ table, rowCount: await this.countRows(adapter, table) });
    }

    const total = exceedsThreshold(plan);
    if (total !== null && !confirm) {
      throw new QueryError(
        `this database holds ${total} rows, over the ${DEFAULT_BACKUP_WARN_ROWS}-row dump threshold; re-send with confirm=true to dump it anyway`,
      );
    }

    return { adapter, plan };
  }

  /** Yield the dump as SQL text, one statement (or comment) at a time. */
  async *run(prepared: PreparedDump): AsyncIterable<string> {
    const { adapter, plan } = prepared;
    yield `-- dbboard logical dump (${adapter.getId()})\n`;

    for (const entry of plan.tables) {
      yield* this.dumpTable(adapter, entry.table);
    }
  }

  private async *dumpTable(adapter: DatabaseAdapter, table: TableInfo): AsyncIterable<string> {
    const name = displayName(table);

    let ddl: string;
    try {
      // `prepare` refused an adapter without the hook, so it is present.
      ddl = await adapter.tableDdl!(table);
    } catch (e) {
      yield failureComment(name, e);
      return;
    }

    yield `\n-- ${name}\n`;
    yield ddl.endsWith("\n") ? ddl : `${ddl}\n`;

    // The primary key is what makes paging possible. An adapter that cannot
    // introspect gets the key-less path rather than a failure.
    let keyColumns: string[] = [];
    if (adapter.describeTable) {
      try {
        keyColumns = (await adapter.describeTable(table)).primary_key;
      } catch (e) {
        yield failureComment(name, e);
        return;
      }
    }

    yield* this.dumpRows(adapter, table, keyColumns);
  }

  private async *dumpRows(
    adapter: DatabaseAdapter,
    table: TableInfo,
    keyColumns: string[],
  ): AsyncIterable<string> {
    const name = displayName(table);
    const keyed = keyColumns.length > 0;
    // The dump is read from one adapter and meant to be loaded back into the
    // same engine, so one dialect covers both halves: the pages this reads and
    // the `INSERT`s it writes. Taking it from the adapter rather than from the
    // request is what stops a SQLite-wire connection emitting `::bytea`.
    const dialect = dialectFor(adapter.getId());
    let cursor: Value[] | undefined;

    for (;;) {
      let result;
      try {
        result = await adapter.executeQuery(
          buildSelectPage(table, keyColumns, READ_PAGE_ROWS, dialect, cursor),
        );
      } catch (e) {
        yield failureComment(name, e);
        return;
      }

      if (result.rows.length === 0) return;

      const columns = result.columns.map((column) => column.name);
      for (let i = 0; i < result.rows.length; i += INSERT_BATCH_ROWS) {
        const statement = buildInsert(
          table,
          columns,
          result.rows.slice(i, i + INSERT_BATCH_ROWS),
          dialect,
        );
        if (statement) yield `${statement}\n`;
      }

      if (!keyed) {
        // No key, no stable cursor. A full page means there was more we
        // cannot reach; say so rather than let the file look complete.
        if (result.rows.length >= READ_PAGE_ROWS) {
          yield `-- !! ${name} truncated at ${result.rows.length} row(s): no primary key to page with\n`;
        }
        return;
      }

      if (result.rows.length < READ_PAGE_ROWS) return;

      const next = cursorFromLastRow(result.rows, columns, keyColumns);
      if (!next) {
        yield failureComment(name, new QueryError("primary-key column missing from result set"));
        return;
      }
      cursor = next;
    }
  }

  // A count that cannot be read is planned at zero. The denominator only
  // feeds the size gate, and the table's real failure surfaces during the
  // run as a comment — failing the whole preflight over one unreadable
  // table would block backing up everything else.
  private async countRows(adapter: DatabaseAdapter, table: TableInfo): Promise<number> {
    try {
      const result = await adapter.executeQuery(buildCount(table, dialectFor(adapter.getId())));
      return toRowCount(result.rows[0]?.[0]);
    } catch {
      return 0;
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

// `COUNT(*)` is int8, and the pool hands int8 back as text — so the cell is
// a string here and a number under an adapter that parses it. Anything else
// (a blob, a null, an unparseable string) counts as zero.
function toRowCount(cell: Value | undefined): number {
  if (typeof cell === "number") return Number.isFinite(cell) ? cell : 0;
  if (typeof cell === "string") {
    const parsed = Number.parseInt(cell, 10);
    return Number.isNaN(parsed) ? 0 : parsed;
  }
  return 0;
}

// The message goes into a `--` comment in a file that is meant to be run, so
// it must not contain a line break: everything after one would stand as SQL.
function failureComment(name: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `-- !! failed to dump ${name}: ${message.replace(/[\r\n]+/g, " ")}\n`;
}

function cursorFromLastRow(
  rows: Value[][],
  columns: string[],
  keyColumns: string[],
): Value[] | undefined {
  const last = rows[rows.length - 1];
  if (!last) return undefined;

  const values: Value[] = [];
  for (const key of keyColumns) {
    const at = columns.indexOf(key);
    if (at === -1 || at >= last.length) return undefined;
    values.push(last[at]!);
  }
  return values;
}

function displayName(table: TableInfo): string {
  return table.schema ? `${table.schema}.${table.name}` : table.name;
}
