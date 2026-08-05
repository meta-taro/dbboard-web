import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, QueryError } from "../domain/errors";
import { DEFAULT_BACKUP_WARN_ROWS, INSERT_BATCH_ROWS, READ_PAGE_ROWS } from "../domain/dump/plan";
import {
  NULL_CAPABILITIES,
  type Capabilities,
  type QueryResult,
  type TableInfo,
  type TableSchema,
  type Value,
} from "../domain/values";
import { DumpDatabase } from "./dump-database.use-case";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";

const DUMP_CAPABILITIES: Capabilities = {
  ...NULL_CAPABILITIES,
  has_describe_table: true,
  has_execute: true,
  has_table_ddl: true,
};

function table(name: string, schema: string | null = "public"): TableInfo {
  return { schema, name };
}

function page(columns: string[], rows: Value[][]): QueryResult {
  return {
    columns: columns.map((name) => ({ name, declared_type: null })),
    rows,
    rows_affected: 0,
  };
}

function countPage(n: number): QueryResult {
  return page(["count"], [[String(n)]]);
}

interface FakeOptions {
  tables?: TableInfo[];
  listTablesError?: Error;
  counts?: Record<string, number | Error>;
  ddl?: Record<string, string | Error>;
  pk?: Record<string, string[] | Error>;
  pages?: Record<string, (QueryResult | Error)[]>;
  capabilities?: Capabilities;
  omitTableDdl?: boolean;
  omitDescribe?: boolean;
}

// Replays scripted results keyed by table name. The SELECT text itself is
// covered by select.spec.ts, so the fake only needs to tell a COUNT from a
// page and hand back the next scripted answer — which keeps the
// orchestration loop deterministic.
class FakeAdapter implements DatabaseAdapter {
  readonly sql: string[] = [];
  private readonly pages: Record<string, (QueryResult | Error)[]>;
  // Instance properties, not methods: absence is the port's "not supported"
  // signal, and a prototype method cannot be made absent.
  readonly tableDdl?: (t: TableInfo) => Promise<string>;
  readonly describeTable?: (t: TableInfo) => Promise<TableSchema>;

  constructor(private readonly options: FakeOptions = {}) {
    this.pages = structuredCloneQueues(options.pages ?? {});
    if (!options.omitTableDdl) this.tableDdl = (t) => this.ddlOf(t);
    if (!options.omitDescribe) this.describeTable = (t) => this.schemaOf(t);
  }

  getId(): string {
    return "fake";
  }

  getCapabilities(): Capabilities {
    return this.options.capabilities ?? DUMP_CAPABILITIES;
  }

  async listTables(): Promise<TableInfo[]> {
    if (this.options.listTablesError) throw this.options.listTablesError;
    return this.options.tables ?? [table("t")];
  }

  async executeQuery(sql: string): Promise<QueryResult> {
    this.sql.push(sql);
    const name = tableNameIn(sql);
    if (sql.startsWith("SELECT COUNT(*)")) {
      const count = this.options.counts?.[name] ?? 0;
      if (count instanceof Error) throw count;
      return countPage(count);
    }
    const queue = this.pages[name];
    const next = queue?.shift() ?? page([], []);
    if (next instanceof Error) throw next;
    return next;
  }

  private async schemaOf(t: TableInfo): Promise<TableSchema> {
    const pk = this.options.pk?.[t.name] ?? [];
    if (pk instanceof Error) throw pk;
    return { table: t, columns: [], primary_key: pk };
  }

  private async ddlOf(t: TableInfo): Promise<string> {
    const ddl = this.options.ddl?.[t.name] ?? `CREATE TABLE "${t.name}" ("id" integer);\n`;
    if (ddl instanceof Error) throw ddl;
    return ddl;
  }
}

function structuredCloneQueues(
  pages: Record<string, (QueryResult | Error)[]>,
): Record<string, (QueryResult | Error)[]> {
  return Object.fromEntries(Object.entries(pages).map(([k, v]) => [k, [...v]]));
}

// The scripted queues are keyed by table, and every statement the dump
// sends names exactly one table.
function tableNameIn(sql: string): string {
  const match = /FROM (?:"[^"]+"\.)?"([^"]+)"/.exec(sql);
  return match?.[1] ?? "";
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

async function collect(chunks: AsyncIterable<string>): Promise<string> {
  let out = "";
  for await (const chunk of chunks) out += chunk;
  return out;
}

function rowsOf(n: number, from = 1): Value[][] {
  return Array.from({ length: n }, (_, i) => [from + i, `r${from + i}`]);
}

describe("DumpDatabase.prepare", () => {
  let registry: StubRegistry;

  beforeEach(() => {
    registry = new StubRegistry();
  });

  function useCase(adapter: DatabaseAdapter): DumpDatabase {
    return new DumpDatabase(adapter, registry);
  }

  it("counts every table and reports the plan", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a"), table("b")],
      counts: { a: 3, b: 7 },
    });

    const prepared = await useCase(adapter).prepare(undefined);

    expect(prepared.plan.tables).toEqual([
      { table: table("a"), rowCount: 3 },
      { table: table("b"), rowCount: 7 },
    ]);
  });

  it("plans a table whose COUNT fails at zero rather than failing the preflight", async () => {
    // A wrong denominator only skews the size gate; the table's real
    // failure surfaces during the run, as a comment.
    const adapter = new FakeAdapter({
      tables: [table("a"), table("b")],
      counts: { a: new QueryError("permission denied"), b: 2 },
    });

    const prepared = await useCase(adapter).prepare(undefined);

    expect(prepared.plan.tables).toEqual([
      { table: table("a"), rowCount: 0 },
      { table: table("b"), rowCount: 2 },
    ]);
  });

  it("propagates a listTables failure", async () => {
    const adapter = new FakeAdapter({ listTablesError: new QueryError("catalog unreadable") });

    await expect(useCase(adapter).prepare(undefined)).rejects.toThrow(QueryError);
  });

  it("refuses an adapter that cannot reconstruct DDL", async () => {
    // A data-only file cannot be loaded into an empty database, which is
    // the one thing a dump promises.
    const adapter = new FakeAdapter({ omitTableDdl: true, capabilities: NULL_CAPABILITIES });

    await expect(useCase(adapter).prepare(undefined)).rejects.toThrow(CapabilityError);
  });

  it("refuses an unknown connection", async () => {
    await expect(useCase(new FakeAdapter()).prepare("nope")).rejects.toThrow(CapabilityError);
  });

  it("dumps the connection's own adapter when an id is given", async () => {
    const scoped = new FakeAdapter({ tables: [table("scoped")], counts: { scoped: 1 } });
    registry.add({ id: "c1", label: "c1", driver: "fake", adapter: scoped });

    const prepared = await useCase(new FakeAdapter()).prepare("c1");

    expect(prepared.plan.tables[0]!.table.name).toBe("scoped");
  });

  it("refuses a database over the warn threshold and names the total", async () => {
    const adapter = new FakeAdapter({
      tables: [table("big")],
      counts: { big: DEFAULT_BACKUP_WARN_ROWS + 1 },
    });

    await expect(useCase(adapter).prepare(undefined)).rejects.toThrow(
      new RegExp(String(DEFAULT_BACKUP_WARN_ROWS + 1)),
    );
    await expect(useCase(adapter).prepare(undefined)).rejects.toThrow(QueryError);
  });

  it("allows the same database with confirm", async () => {
    const adapter = new FakeAdapter({
      tables: [table("big")],
      counts: { big: DEFAULT_BACKUP_WARN_ROWS + 1 },
    });

    const prepared = await useCase(adapter).prepare(undefined, true);

    expect(prepared.plan.tables[0]!.rowCount).toBe(DEFAULT_BACKUP_WARN_ROWS + 1);
  });
});

describe("DumpDatabase.run", () => {
  const registry = new StubRegistry();

  function useCase(adapter: DatabaseAdapter): DumpDatabase {
    return new DumpDatabase(adapter, registry);
  }

  it("emits a header, the DDL, and the rows of each table", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a")],
      counts: { a: 2 },
      ddl: { a: 'CREATE TABLE "public"."a" (\n    "id" integer\n);\n' },
      pk: { a: ["id"] },
      pages: { a: [page(["id", "note"], rowsOf(2))] },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toBe(
      "-- dbboard logical dump (fake)\n" +
        "\n-- public.a\n" +
        'CREATE TABLE "public"."a" (\n    "id" integer\n);\n' +
        `INSERT INTO "public"."a" ("id", "note") VALUES ('1', 'r1'), ('2', 'r2');\n`,
    );
  });

  it("terminates DDL with a newline when the adapter did not", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a")],
      ddl: { a: 'CREATE TABLE "a" ();' },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain('CREATE TABLE "a" ();\n');
  });

  it("emits no INSERT for an empty table", async () => {
    const adapter = new FakeAdapter({ tables: [table("a")], pages: { a: [page(["id"], [])] } });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).not.toContain("INSERT");
  });

  it("pages with a keyset cursor taken from the last row of the page", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a")],
      pk: { a: ["id"] },
      pages: {
        a: [
          page(["id", "note"], rowsOf(READ_PAGE_ROWS)),
          page(["id", "note"], rowsOf(1, READ_PAGE_ROWS + 1)),
        ],
      },
    });
    const dump = useCase(adapter);

    await collect(dump.run(await dump.prepare(undefined)));

    const selects = adapter.sql.filter((s) => s.startsWith("SELECT *"));
    expect(selects).toHaveLength(2);
    expect(selects[0]).not.toContain("WHERE");
    expect(selects[1]).toContain(`WHERE ("id") > ('${READ_PAGE_ROWS}')`);
  });

  it("stops paging on a short page without asking for another", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a")],
      pk: { a: ["id"] },
      pages: { a: [page(["id", "note"], rowsOf(3))] },
    });
    const dump = useCase(adapter);

    await collect(dump.run(await dump.prepare(undefined)));

    expect(adapter.sql.filter((s) => s.startsWith("SELECT *"))).toHaveLength(1);
  });

  it("splits a page into INSERT batches", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a")],
      pk: { a: ["id"] },
      pages: { a: [page(["id", "note"], rowsOf(INSERT_BATCH_ROWS + 1))] },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out.match(/INSERT INTO/g)).toHaveLength(2);
  });

  it("reads a key-less table once and says so when the page filled", async () => {
    // Without a key there is no stable cursor, so the rest of the table is
    // unreachable. A silent short file is the failure mode worth naming.
    const adapter = new FakeAdapter({
      tables: [table("a")],
      pk: { a: [] },
      pages: { a: [page(["id"], rowsOf(READ_PAGE_ROWS))] },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(adapter.sql.filter((s) => s.startsWith("SELECT *"))).toHaveLength(1);
    expect(out).toContain(`-- !! public.a truncated at ${READ_PAGE_ROWS} row(s): no primary key`);
  });

  it("does not call describeTable when the adapter cannot introspect", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a")],
      omitDescribe: true,
      capabilities: { ...DUMP_CAPABILITIES, has_describe_table: false },
      pages: { a: [page(["id"], rowsOf(1))] },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain("INSERT INTO");
  });

  it("turns a DDL failure into a comment and keeps going", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a"), table("b")],
      ddl: { a: new QueryError("permission denied for table a") },
      pages: { b: [page(["id"], rowsOf(1))] },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain("-- !! failed to dump public.a: permission denied for table a");
    expect(out).not.toContain('INSERT INTO "public"."a"');
    expect(out).toContain('INSERT INTO "public"."b"');
  });

  it("turns a describeTable failure into a comment and keeps going", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a"), table("b")],
      pk: { a: new QueryError("catalog unreadable") },
      pages: { b: [page(["id"], rowsOf(1))] },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain("-- !! failed to dump public.a: catalog unreadable");
    expect(out).toContain('INSERT INTO "public"."b"');
  });

  it("turns a mid-table read failure into a comment and keeps going", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a"), table("b")],
      pk: { a: ["id"] },
      pages: {
        a: [page(["id", "note"], rowsOf(READ_PAGE_ROWS)), new QueryError("connection lost")],
        b: [page(["id"], rowsOf(1))],
      },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain('INSERT INTO "public"."a"'); // the page that did arrive
    expect(out).toContain("-- !! failed to dump public.a: connection lost");
    expect(out).toContain('INSERT INTO "public"."b"');
  });

  it("flattens a failure message so it cannot break out of its comment", async () => {
    // An error carrying a newline would otherwise end the comment and leave
    // the rest of the message standing as SQL in a file meant to be run.
    const adapter = new FakeAdapter({
      tables: [table("a")],
      ddl: { a: new QueryError("boom\nDROP TABLE users;\r-- ") },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain("-- !! failed to dump public.a: boom DROP TABLE users; -- \n");
    expect(out.split("\n").every((line) => !line.startsWith("DROP TABLE"))).toBe(true);
  });

  it("reports a key column missing from the result set rather than looping", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a")],
      pk: { a: ["id"] },
      pages: {
        a: [
          page(
            ["note"],
            Array.from({ length: READ_PAGE_ROWS }, () => ["x"]),
          ),
        ],
      },
    });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain("-- !! failed to dump public.a: primary-key column missing");
    expect(adapter.sql.filter((s) => s.startsWith("SELECT *"))).toHaveLength(1);
  });

  it("names an unqualified table without a leading dot", async () => {
    const adapter = new FakeAdapter({ tables: [table("a", null)] });
    const dump = useCase(adapter);

    const out = await collect(dump.run(await dump.prepare(undefined)));

    expect(out).toContain("\n-- a\n");
  });

  it("streams: nothing is read until the output is pulled", async () => {
    const adapter = new FakeAdapter({
      tables: [table("a"), table("b")],
      pk: { a: ["id"], b: ["id"] },
      pages: {
        a: [page(["id", "note"], rowsOf(3))],
        b: [page(["id", "note"], rowsOf(3))],
      },
    });
    const dump = useCase(adapter);
    const prepared = await dump.prepare(undefined);
    const reads = adapter.sql.length;

    const iterator = dump.run(prepared)[Symbol.asyncIterator]();
    const first = await iterator.next();

    expect(first.value).toBe("-- dbboard logical dump (fake)\n");
    expect(adapter.sql.length).toBe(reads); // no table touched yet
    await iterator.return?.(undefined);
  });
});
