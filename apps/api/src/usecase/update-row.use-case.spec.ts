import { describe, expect, it, vi } from "vitest";
import type { DatabaseAdapter } from "../domain/database-adapter.port";
import { CapabilityError, ConflictError, QueryError } from "../domain/errors";
import { NULL_CAPABILITIES } from "../domain/values";
import type { UpdatePlan } from "../domain/write-back";
import type { ConnectionRecord, ConnectionRegistry } from "./connection-registry.port";
import { UpdateRow } from "./update-row.use-case";

// The first write path in the service. The tests below are about the two
// things that make it different from every read use case: it refuses rather
// than degrades, and it verifies afterwards that it changed exactly one row.

const plan: UpdatePlan = {
  table: { schema: "public", name: "users" },
  key: [{ column: "id", value: 7 }],
  edits: [{ column: "email", value: { kind: "text", text: "new@example.com" } }],
};

function writing(name: string, affected: number | (() => Promise<number>)): DatabaseAdapter {
  return {
    getId: () => name,
    getCapabilities: () => ({ ...NULL_CAPABILITIES, has_execute: true }),
    listTables: async () => [],
    executeQuery: async () => ({ columns: [], rows: [], rows_affected: 0 }),
    execute: vi
      .fn()
      .mockImplementation(async () => (typeof affected === "number" ? affected : affected())),
  };
}

// An adapter with no `execute` — the port keeps it optional so a read-only
// driver needs no change, and absence is the "not supported" signal.
function readOnly(name: string): DatabaseAdapter {
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

function record(id: string, adapter: DatabaseAdapter): ConnectionRecord {
  return { id, driver: adapter.getId(), label: id, adapter };
}

describe("UpdateRow", () => {
  it("executes the built statement on the registry-resolved adapter", async () => {
    const scoped = writing("conn-a", 1);
    const other = writing("conn-b", 1);
    const useCase = new UpdateRow(
      readOnly("default"),
      registry([record("a", scoped), record("b", other)]),
    );

    await useCase.execute("a", plan);

    expect(scoped.execute).toHaveBeenCalledWith(
      `UPDATE "public"."users" SET "email" = 'new@example.com' WHERE "id" = 7`,
    );
    expect(other.execute).not.toHaveBeenCalled();
  });

  it("returns the affected count on the one outcome that is a success", async () => {
    const adapter = writing("conn-a", 1);
    const useCase = new UpdateRow(readOnly("default"), registry([record("a", adapter)]));
    await expect(useCase.execute("a", plan)).resolves.toBe(1);
  });

  it("refuses an unknown connection", async () => {
    const useCase = new UpdateRow(readOnly("default"), registry([]));
    await expect(useCase.execute("nope", plan)).rejects.toBeInstanceOf(CapabilityError);
  });

  it("refuses an adapter that cannot write, naming it", async () => {
    // Not a 500 and not a silent no-op: the connection exists but this
    // driver has no write primitive, which is a 404 "capability" — the same
    // shape the schema routes use when introspection is unavailable.
    const useCase = new UpdateRow(readOnly("default"), registry([record("a", readOnly("null"))]));
    await expect(useCase.execute("a", plan)).rejects.toThrowError(/null/);
    await expect(useCase.execute("a", plan)).rejects.toBeInstanceOf(CapabilityError);
  });

  it("does not touch the database when the plan is refused", async () => {
    // The refusal has to come before the statement, not after it. An empty
    // key would otherwise mean an UPDATE with no WHERE has already run.
    const adapter = writing("conn-a", 1);
    const useCase = new UpdateRow(readOnly("default"), registry([record("a", adapter)]));

    await expect(useCase.execute("a", { ...plan, key: [] })).rejects.toBeInstanceOf(QueryError);
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("surfaces a write-back refusal as the caller's fault, keeping the reason", async () => {
    const adapter = writing("conn-a", 1);
    const useCase = new UpdateRow(readOnly("default"), registry([record("a", adapter)]));
    await expect(useCase.execute("a", { ...plan, edits: [] })).rejects.toThrowError(
      /no columns were edited/,
    );
  });

  describe("the exactly-one gate", () => {
    it("reports zero matches as a conflict the user can act on", async () => {
      // The realistic failure: someone else changed or deleted the row
      // between the browse and the save. Nothing was written.
      const useCase = new UpdateRow(readOnly("default"), registry([record("a", writing("c", 0))]));
      await expect(useCase.execute("a", plan)).rejects.toBeInstanceOf(ConflictError);
      await expect(useCase.execute("a", plan)).rejects.toThrowError(/no row matched/);
    });

    it("reports several matches as a conflict, naming the count", async () => {
      const useCase = new UpdateRow(readOnly("default"), registry([record("a", writing("c", 3))]));
      await expect(useCase.execute("a", plan)).rejects.toThrowError(/but 3 matched/);
    });

    it("does not let a conflict read as a bad request", async () => {
      // 409, not 400: the request was well-formed and the client's correct
      // response is to reload, not to fix what it sent.
      const useCase = new UpdateRow(readOnly("default"), registry([record("a", writing("c", 0))]));
      await expect(useCase.execute("a", plan)).rejects.not.toBeInstanceOf(QueryError);
    });
  });

  it("lets an engine error through untranslated", async () => {
    // A constraint violation is the adapter's to categorise; wrapping it
    // here would relabel a real 400 as a conflict.
    const boom = new QueryError('duplicate key value violates unique constraint "users_email_key"');
    const adapter = writing("conn-a", () => Promise.reject(boom));
    const useCase = new UpdateRow(readOnly("default"), registry([record("a", adapter)]));
    await expect(useCase.execute("a", plan)).rejects.toBe(boom);
  });
});
