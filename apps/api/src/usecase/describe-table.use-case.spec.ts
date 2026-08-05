import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError } from "../domain/errors";
import { NULL_CAPABILITIES, type TableInfo, type TableSchema } from "../domain/values";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { DescribeTable } from "./describe-table.use-case";

const users: TableInfo = { schema: "public", name: "users" };

function schemaOf(table: TableInfo): TableSchema {
  return {
    table,
    columns: [
      {
        name: "id",
        declared_type: "integer",
        nullable: false,
        primary_key: true,
        ordinal: 1,
        default_value: "nextval('users_id_seq'::regclass)",
      },
    ],
    primary_key: ["id"],
  };
}

function describing(name: string): DatabaseAdapter {
  return {
    getId: () => name,
    getCapabilities: () => ({ ...NULL_CAPABILITIES, has_describe_table: true }),
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
    describeTable: vi.fn().mockImplementation(async (t: TableInfo) => schemaOf(t)),
  };
}

// An adapter that predates ADR-0028 — the port's `describeTable` is
// optional precisely so NullAdapter needs no change.
function plain(name: string): DatabaseAdapter {
  return {
    getId: () => name,
    getCapabilities: () => NULL_CAPABILITIES,
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
  };
}

function registry(records: ConnectionRecord[]): ConnectionRegistry {
  const map = new Map(records.map((r) => [r.id, r]));
  return {
    add: () => undefined,
    list: () => [...map.values()],
    get: (id) => map.get(id),
    delete: () => true,
  };
}

describe("DescribeTable", () => {
  it("dispatches to the registry-resolved adapter and returns its TableSchema", async () => {
    const scoped = describing("conn-a");
    const useCase = new DescribeTable(
      plain("default"),
      registry([{ id: "conn-a", label: "A", driver: "postgres", adapter: scoped }]),
    );

    await expect(useCase.execute("conn-a", users)).resolves.toEqual(schemaOf(users));
    expect(scoped.describeTable).toHaveBeenCalledWith(users);
  });

  it("dispatches to the default adapter when no connectionId is supplied", async () => {
    const defaultAdapter = describing("default");
    const useCase = new DescribeTable(defaultAdapter, registry([]));

    await expect(useCase.execute(undefined, users)).resolves.toEqual(schemaOf(users));
    expect(defaultAdapter.describeTable).toHaveBeenCalledOnce();
  });

  it("raises CapabilityError for an unknown connectionId so the route 404s", async () => {
    const useCase = new DescribeTable(describing("default"), registry([]));

    await expect(useCase.execute("missing", users)).rejects.toBeInstanceOf(CapabilityError);
    await expect(useCase.execute("missing", users)).rejects.toThrow(/unknown connection/);
  });

  // The flag and the method are two separate promises; an adapter that
  // advertises neither must fail as "not supported here", not as a
  // TypeError from calling undefined.
  it("raises CapabilityError when the resolved adapter cannot describe", async () => {
    const useCase = new DescribeTable(
      plain("default"),
      registry([{ id: "conn-b", label: "B", driver: "null", adapter: plain("conn-b") }]),
    );

    await expect(useCase.execute("conn-b", users)).rejects.toBeInstanceOf(CapabilityError);
    await expect(useCase.execute("conn-b", users)).rejects.toThrow(/describe/i);
  });
});
